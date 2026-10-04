// test/program-rule.test.mjs — the rule program: one ruler rules a changed spec from an inline brief,
// its rulings are settled, refused rulings go back to it, and the user's word on a change some ruling
// found affected is confirmed against the latest ruled line; and respecSettle's `by` and `over`.
//
// Design: docs/DESIGN.md#a-changed-spec, docs/DESIGN.md#the-users-word.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { actToken, approvalState, recordApproval } from '../lib/approval.mjs'
import { compileEffort } from '../lib/compile.mjs'
import { renderMessage } from '../lib/conversation.mjs'
import { fileFor, readLog, readRunLog, runLog, runState } from '../lib/ledger.mjs'
import { programContext } from '../lib/programs/common.mjs'
import { attachedOnly, rule, scopeOf } from '../lib/programs/rule.mjs'
import { respecBrief, respecSettle } from '../lib/respec.mjs'
import { loadRole, tierFor } from '../lib/roles.mjs'
import { schemaOf } from '../lib/schemas.mjs'
import { mainCheckout, pidAlive, posix, readJson, resultPath, runLogFile, specPath } from '../lib/store.mjs'
import { programRig } from './harness/program-rig.mjs'

const RUN_CLI = fileURLToPath(new URL('../lib/run.mjs', import.meta.url))
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
const APPROVE_RUN = 'approve-run'

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
const AFFECTED_AGAIN = { cli: { ruling: 'affected', why: 'it writes into the loaded object', question: 'Should the CLI clone the config first?' } }
const rulerScript = (...outputs) => ({ 'ruler||ruler': outputs.map((output) => ({ output })) })

const args = (folder, user_approved = false) => ({ effort: E, folder, user_approved })
const ledger = (repo, kind) => readLog(repo, E, 'ledger').entries.filter((l) => l.kind === kind)
const approvalsOf = (repo, folder) => ledger(repo, 'approved').filter((l) => l.folder === folder)
const latestRuled = (repo, folder) => ledger(repo, 'ruled').filter((l) => l.folder === folder).at(-1)
const tokenOf = (folder, hash, seq) => actToken({ act: 'approve', folder, hash, seq })
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
  return { rig, folder, brief, first, token: tokenOf(folder, brief.hash, first.ruled) }
}

const noDispatch = () => { throw new Error('a user-approved rule run dispatches nothing') }

/** The user's approval: a second run over the same repository. */
const approvalContext = (rig, { run = APPROVE_RUN, log, env = {}, stdinIsTTY = false, ask = null } = {}) =>
  programContext({ ...rig.ctx, run, log: log ?? runLog(rig.repo, run), runAgent: noDispatch, env, stdinIsTTY, ask })

/** An ask that records each prompt and answers `answer`. */
function asker(answer) {
  const prompts = []
  const ask = async (prompt) => {
    prompts.push(prompt)
    return typeof answer === 'function' ? answer(prompt) : answer
  }
  return { ask, prompts }
}

const answerLine = (question, answer) => JSON.stringify({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't-x', content: 'answered' }] },
  toolUseResult: { questions: [{ question }], answers: { [question]: answer } },
})

/** A session whose transcript answers `answer` to a question holding `token`; its env. */
function session(t, token, answer) {
  const config = mkdtempSync(join(tmpdir(), 'agentics-rule-session-'))
  t.after(() => rmSync(config, { recursive: true, force: true }))
  const id = randomUUID()
  mkdirSync(join(config, 'projects', 'some-project'), { recursive: true })
  writeFileSync(join(config, 'projects', 'some-project', id + '.jsonl'), answerLine('Approve the change to api? ' + token, answer) + '\n')
  return { CLAUDE_CODE_SESSION_ID: id, CLAUDE_CONFIG_DIR: config }
}

// --- the program module ----------------------------------------------------------------------

test('a rule run is scoped by its effort and folder', () => {
  const at = { repo: '/r', root: '/r' }
  assert.deepEqual(scopeOf(args('api'), at), { effort: E, folder: 'api' })
  assert.deepEqual(scopeOf(args('api', true), at), { effort: E, folder: 'api' })
  assert.deepEqual(scopeOf(args('.'), at), { effort: E, folder: '.' })
})

test("a rule run takes the user's word attached only", () => {
  assert.equal(attachedOnly(args('api', true)), true)
  assert.equal(attachedOnly(args('api', false)), false)
})

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

test("one ruler rules the change at its role's tier", async (t) => {
  const { rig, folder, brief } = changed(t)
  const run = rig.relaunch(rulerScript(rulingsOf(brief)))
  await rule(run.ctx, args(folder))
  assert.equal(run.calls.length, 1)
  const [call] = run.calls
  assert.equal(call.role.name, 'ruler')
  assert.equal(call.thread.key, 'ruler')
  assert.deepEqual(call.schema, schemaOf('ruler_premises'))
  assert.deepEqual(call.tier, tierFor(loadRole('ruler').role))
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

test('an inline brief is written where settle records it and returned whole', (t) => {
  const { rig, folder, brief } = changed(t)
  const inline = respecBrief(rig.repo, E, folder, { inline: true })
  assert.equal(inline.status, 'brief', JSON.stringify(inline))
  assert.deepEqual([inline.brief, inline.rulings, inline.basis, inline.hash, inline.from], [brief.brief, brief.rulings, brief.basis, brief.hash, brief.from])
  assert.deepEqual(inline.nodes, brief.nodes)
  assert.equal(typeof inline.text, 'string')
  assert.ok(inline.text.length > 0)
  assert.equal(readFileSync(inline.brief, 'utf8'), inline.text, 'the brief file holds the text returned')
  assert.ok(!Object.hasOwn(inline, 'prompt'), 'an inline brief has no prompt pointing at files')
  assert.ok(!inline.text.includes(inline.rulings), 'the rulings come back as the structured return, not through a file')

  writeFileSync(inline.rulings, JSON.stringify(rulingsOf(inline)))
  const out = respecSettle(rig.repo, E, folder)
  assert.equal(ledger(rig.repo, 'ruled').find((l) => l.seq === out.ruled).brief, inline.brief)
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

test('an affected ruling goes to the user with the token to ask by', async (t) => {
  const { rig, folder, brief } = changed(t)
  const before = approvalsOf(rig.repo, folder).length
  const out = await rule(rig.relaunch(rulerScript(rulingsOf(brief, AFFECTED))).ctx, args(folder))
  const line = latestRuled(rig.repo, folder)
  assert.deepEqual([out.status, out.folder, out.hash, out.ruled], ['needs_user', folder, brief.hash, line.seq], JSON.stringify(out))
  assert.deepEqual(out.affected, line.rulings.filter((r) => r.ruling === 'affected'))
  assert.deepEqual(out.affected.map((a) => a.node), ['cli'])
  assert.deepEqual(out.reasons, [])
  assert.equal(out.token, tokenOf(folder, brief.hash, line.seq))
  assert.equal(approvalState(rig.repo, E, folder).state, 'edited')
  assert.equal(approvalsOf(rig.repo, folder).length, before)
})

test('a changed decision goes to the user whatever the rulings', async (t) => {
  const { rig, folder, brief } = changed(t, 'decision')
  const out = await rule(rig.relaunch(rulerScript(rulingsOf(brief))).ctx, args(folder))
  const line = latestRuled(rig.repo, folder)
  assert.deepEqual([out.status, out.ruled], ['needs_user', line.seq], JSON.stringify(out))
  assert.deepEqual(out.affected, [])
  assert.ok(out.reasons.some((r) => r.includes('D2')), JSON.stringify(out.reasons))
  assert.equal(out.token, tokenOf(folder, brief.hash, line.seq))
  assert.equal(approvalState(rig.repo, E, folder).state, 'edited')
})

test('refused rulings go back to the ruler, and its corrected rulings settle', async (t) => {
  const { rig, folder, brief } = changed(t)
  const missing = { rulings: rulingsOf(brief).rulings.filter((r) => r.node !== 'cli') }
  const run = rig.relaunch(rulerScript(missing, rulingsOf(brief)))
  const out = await rule(run.ctx, args(folder))
  const messages = runRecords(rig.repo, rig.run, 'message').filter((m) => m.thread === 'ruler')
  assert.equal(messages.length, 1)
  const [message] = messages
  assert.deepEqual([message.msg, message.round], ['refusals', 2])
  assert.ok(message.payload.refusals[0].problem.includes('cli'), JSON.stringify(message.payload))
  assert.equal(run.calls.length, 2)
  assert.equal(run.calls[1].thread.key, 'ruler')
  assert.equal(run.calls[1].resume, true, 'the second call resumes the ruler\'s session')
  assert.equal(run.calls[1].brief, renderMessage({ msg: message.msg, payload: message.payload }))
  assert.equal(out.status, 'approved', JSON.stringify(out))
  assert.deepEqual(JSON.parse(readFileSync(brief.rulings, 'utf8')), rulingsOf(brief), 'the rulings file holds the corrected round, whole')
})

test('an empty why, or an affected ruling with neither question nor fix, goes back to the ruler', async (t) => {
  const { rig, folder, brief } = changed(t)
  const run = rig.relaunch(rulerScript(
    rulingsOf(brief, { cli: { why: '' } }),
    rulingsOf(brief, { cli: { ruling: 'affected', why: 'it mutates what load returns', question: '', fix: '' } }),
    rulingsOf(brief),
  ))
  const out = await rule(run.ctx, args(folder))
  const messages = runRecords(rig.repo, rig.run, 'message').filter((m) => m.thread === 'ruler')
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
  const run = rig.relaunch({ 'ruler||ruler': [{ status: 'failed', cause: 'host_error' }] })
  const out = await rule(run.ctx, args(folder))
  assert.deepEqual([out.status, out.next], ['refused', 'rule_it'], JSON.stringify(out))
  assert.deepEqual(out.coverage.failed_channels, ['ruler'])
  assert.equal(out.coverage.complete, false)
  assert.equal(ledger(rig.repo, 'ruled').length, 0)
  assert.equal(approvalState(rig.repo, E, folder).state, 'edited')
})

test('a compile refusal passes through as compile_refused', async (t) => {
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
  await assert.rejects(rule(programContext({ ...run.ctx, runAgent }), args(folder)))
  const again = rig.relaunch({})
  const out = await rule(again.ctx, args(folder))
  assert.equal(again.calls.length, 0)
  assert.equal(out.status, 'approved', JSON.stringify(out))
  assert.equal(approvalState(rig.repo, E, folder).compiled_hash, brief.hash)
})

// --- the user's word -------------------------------------------------------------------------

test('without a ruling at the spec as it stands the user cannot approve', async (t) => {
  const unruled = changed(t)
  const before = approvalsOf(unruled.rig.repo, 'api').length
  const asked = asker('approve api')
  const out = await rule(approvalContext(unruled.rig, { stdinIsTTY: true, ask: asked.ask }), args('api', true))
  assert.deepEqual([out.status, out.next], ['refused', 'rule_it'], JSON.stringify(out))
  assert.equal(asked.prompts.length, 0)
  assert.equal(approvalState(unruled.rig.repo, E, 'api').state, 'edited')
  assert.equal(approvalsOf(unruled.rig.repo, 'api').length, before)

  // Ruled, then edited again: the ruled line is at a hash the spec has moved on from.
  const { rig, folder, token } = await needsUser(t)
  const approvals = approvalsOf(rig.repo, folder).length
  writeSpec(rig.repo, folder, EDITS.wording.text.replace('A loader and a parser', 'A loader, a parser and a validator'))
  const stale = asker(token)
  const moved = await rule(approvalContext(rig, { stdinIsTTY: true, ask: stale.ask }), args(folder, true))
  assert.deepEqual([moved.status, moved.next], ['refused', 'rule_it'], JSON.stringify(moved))
  assert.equal(stale.prompts.length, 0)
  assert.equal(approvalState(rig.repo, E, folder).state, 'edited')
  assert.equal(approvalsOf(rig.repo, folder).length, approvals)
})

test("the user's Approve in the session's transcript approves over the ruling", async (t) => {
  const { rig, folder, brief, first, token } = await needsUser(t)
  const ctx = approvalContext(rig, { env: session(t, token, 'Approve') })
  const out = await rule(ctx, args(folder, true))
  assert.deepEqual([out.status, out.by, out.ruled], ['approved', 'user', first.ruled], JSON.stringify(out))
  const approval = approvalsOf(rig.repo, folder).at(-1)
  assert.deepEqual([approval.hash, approval.by, approval.ruled], [brief.hash, 'user', first.ruled])
  assert.equal(approvalState(rig.repo, E, folder).compiled_hash, brief.hash)
  assertCompleteCoverage(out, ctx, 'approved by the user')
})

test('the token typed back at a terminal approves over the ruling, by the terminal', async (t) => {
  const { rig, folder, brief, first, token } = await needsUser(t)
  const asked = asker(token)
  const out = await rule(approvalContext(rig, { stdinIsTTY: true, ask: asked.ask }), args(folder, true))
  assert.deepEqual([out.status, out.by, out.ruled], ['approved', 'terminal', first.ruled], JSON.stringify(out))
  const approval = approvalsOf(rig.repo, folder).at(-1)
  assert.deepEqual([approval.hash, approval.by, approval.ruled], [brief.hash, 'terminal', first.ruled])
  assert.equal(asked.prompts.length, 1)
  assert.ok(asked.prompts[0].includes(token), asked.prompts[0])
  assert.equal(approvalState(rig.repo, E, folder).compiled_hash, brief.hash)
})

test('a word not confirmed is refused ask_user with the token', async (t) => {
  const { rig, folder, token } = await needsUser(t)
  const before = approvalsOf(rig.repo, folder).length
  const rejected = await rule(approvalContext(rig, { env: session(t, token, 'Reject') }), args(folder, true))
  const nobody = await rule(approvalContext(rig, { run: 'approve-run-2', env: {}, stdinIsTTY: false }), args(folder, true))
  for (const [label, out] of [['Reject', rejected], ['no session and no console', nobody]]) {
    assert.deepEqual([out.status, out.next, out.token], ['refused', 'ask_user', token], label + ': ' + JSON.stringify(out))
    assert.equal(typeof out.why, 'string', label)
    assert.ok(out.why.length > 0, label)
  }
  assert.equal(approvalState(rig.repo, E, folder).state, 'edited')
  assert.equal(approvalsOf(rig.repo, folder).length, before)
})

test('a ruling recorded while the user confirms is refused rule_it', async (t) => {
  const { rig, folder, brief, first, token } = await needsUser(t)
  const before = approvalsOf(rig.repo, folder).length
  const asked = asker(() => {
    writeFileSync(brief.rulings, JSON.stringify(rulingsOf(brief, AFFECTED_AGAIN)))
    respecSettle(rig.repo, E, folder, { checkUserBound: true })
    return token
  })
  const out = await rule(approvalContext(rig, { stdinIsTTY: true, ask: asked.ask }), args(folder, true))
  assert.ok(latestRuled(rig.repo, folder).seq > first.ruled, 'a newer ruled line was recorded during the ask')
  assert.deepEqual([out.status, out.next], ['refused', 'rule_it'], JSON.stringify(out))
  assert.equal(approvalState(rig.repo, E, folder).state, 'edited')
  assert.equal(approvalsOf(rig.repo, folder).length, before)
})

test('a relaunch of a confirmed approval asks the user nothing again', async (t) => {
  const { rig, folder, brief, token } = await needsUser(t)
  const first = await rule(approvalContext(rig, { stdinIsTTY: true, ask: asker(token).ask }), args(folder, true))
  assert.equal(first.status, 'approved', JSON.stringify(first))
  const again = asker(token)
  const second = await rule(approvalContext(rig, { stdinIsTTY: true, ask: again.ask }), args(folder, true))
  assert.equal(again.prompts.length, 0)
  assert.deepEqual(second, first)
  assert.equal(approvalsOf(rig.repo, folder).filter((l) => l.hash === brief.hash).length, 1)
})

test('a relaunch after the change was ruled again asks the user again and approves nothing on the earlier word', async (t) => {
  const { rig, folder, brief, token } = await needsUser(t)
  const before = approvalsOf(rig.repo, folder).length
  const base = runLog(rig.repo, APPROVE_RUN)
  let answered = false
  const killing = {
    append(kind, fields) {
      const out = base.append(kind, fields)
      if (answered) throw new Error('killed once the user\'s word was recorded')
      return out
    },
    entries: () => base.entries(),
  }
  const firstAsk = asker(() => { answered = true; return token })
  await assert.rejects(rule(approvalContext(rig, { log: killing, stdinIsTTY: true, ask: firstAsk.ask }), args(folder, true)))
  assert.equal(firstAsk.prompts.length, 1)

  writeFileSync(brief.rulings, JSON.stringify(rulingsOf(brief, AFFECTED_AGAIN)))
  const reruled = respecSettle(rig.repo, E, folder, { checkUserBound: true })
  assert.equal(reruled.hash, brief.hash)
  assert.equal(reruled.ruled, latestRuled(rig.repo, folder).seq)
  const newer = tokenOf(folder, brief.hash, reruled.ruled)
  assert.notEqual(newer, token)

  const relaunched = asker(token)
  const out = await rule(approvalContext(rig, { stdinIsTTY: true, ask: relaunched.ask }), args(folder, true))
  assert.equal(relaunched.prompts.length, 1)
  assert.ok(relaunched.prompts[0].includes(newer), relaunched.prompts[0])
  assert.deepEqual([out.status, out.next, out.token], ['refused', 'ask_user', newer], JSON.stringify(out))
  assert.equal(approvalState(rig.repo, E, folder).state, 'edited')
  assert.equal(approvalsOf(rig.repo, folder).length, before)
})

// --- respecSettle's new options --------------------------------------------------------------

test('settle records who approved a user-approved change', (t) => {
  const { rig, folder, brief } = changed(t)
  writeFileSync(brief.rulings, JSON.stringify(rulingsOf(brief, AFFECTED)))
  const ruled = respecSettle(rig.repo, E, folder)
  assert.equal(ruled.status, 'needs_user')
  const out = respecSettle(rig.repo, E, folder, { userApproved: true, by: 'terminal', over: ruled.ruled })
  assert.deepEqual([out.status, out.by, out.ruled], ['approved', 'terminal', ruled.ruled], JSON.stringify(out))
  const approval = approvalsOf(rig.repo, folder).at(-1)
  assert.deepEqual([approval.by, approval.ruled], ['terminal', ruled.ruled])
})

test('settle over a stale ruled line is refused rule_it', (t) => {
  const { rig, folder, brief } = changed(t)
  writeFileSync(brief.rulings, JSON.stringify(rulingsOf(brief, AFFECTED)))
  const stale = respecSettle(rig.repo, E, folder)
  writeFileSync(brief.rulings, JSON.stringify(rulingsOf(brief, AFFECTED_AGAIN)))
  const latest = respecSettle(rig.repo, E, folder)
  assert.ok(latest.ruled > stale.ruled)
  const before = approvalsOf(rig.repo, folder).length
  const ledgerSize = readLog(rig.repo, E, 'ledger').entries.length

  const refused = respecSettle(rig.repo, E, folder, { userApproved: true, over: stale.ruled })
  assert.deepEqual([refused.status, refused.next], ['refused', 'rule_it'], JSON.stringify(refused))
  assert.equal(readLog(rig.repo, E, 'ledger').entries.length, ledgerSize, 'nothing is appended')
  assert.equal(approvalState(rig.repo, E, folder).state, 'edited')

  const out = respecSettle(rig.repo, E, folder, { userApproved: true, over: latest.ruled })
  assert.deepEqual([out.status, out.by, out.ruled], ['approved', 'user', latest.ruled], JSON.stringify(out))
  assert.equal(approvalsOf(rig.repo, folder).length, before + 1)
})

// --- the real CLI ----------------------------------------------------------------------------

/** A rig holding the root spec, never approved, whose host CLI resolves. */
function neverApproved(t) {
  const rig = programRig({ files: { 'CLAUDE.md': GUIDE + '\n' }, config: { claude_cli: process.execPath } })
  writeSpec(rig.repo, '.', ROOT)
  return rig
}
const cli = (rig, ...flags) => {
  const out = execFileSync(process.execPath, [RUN_CLI, 'rule', '--repo', rig.repo, ...flags], {
    encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: '', CLAUDE_CODE_SESSION_ID: '' }, windowsHide: true,
  })
  return JSON.parse(out.trim().split('\n').at(-1))
}

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
    while (pid && pidAlive(pid)) await new Promise((wake) => setTimeout(wake, 50))
    rig.cleanup()
  })
  const out = cli(rig, '--detach', '--effort', E, '--folder', '.')
  pid = out.pid
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(typeof out.run, 'string')
  assert.ok(Number.isInteger(out.pid) && out.pid > 0)
  assert.equal(out.log, runLogFile(rig.repo, out.run))
  assert.equal(out.result_file, resultPath(rig.repo, out.run))

  for (;;) {
    if (runState(rig.repo, out.run).state === 'ended' && !pidAlive(out.pid)) break
    await new Promise((wake) => setTimeout(wake, 50))
  }
  assert.equal(runRecords(rig.repo, out.run, 'ended').at(-1).result.status, 'done')
  const result = readJson(resultPath(rig.repo, out.run))
  assert.deepEqual([result.status, result.next, result.run], ['refused', 'user_approves', out.run], JSON.stringify(result))
  assert.equal(result.coverage.complete, true)
})

test('rule --user-approved refuses --detach', (t) => {
  const rig = neverApproved(t)
  t.after(() => rig.cleanup())
  const out = cli(rig, '--user-approved', '--detach', '--effort', E, '--folder', '.')
  assert.equal(out.ok, false, JSON.stringify(out))
  assert.equal(out.error.kind, 'attached_only')
})
