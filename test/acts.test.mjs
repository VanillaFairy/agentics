// test/acts.test.mjs — the user's two acts, approving a spec and landing into their branch, rest on
// their own confirmed word: a session's latest answer to a question holding the act's token, or the
// token typed back at their terminal; a word given to an earlier text or head confirms nothing.
//
// Design: docs/DESIGN.md#the-users-word, docs/DESIGN.md#landing-and-drift.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { actToken, approvalState, approveAct, recordApproval } from '../lib/approval.mjs'
import { land, landAct } from '../lib/boundary.mjs'
import { append, readLog } from '../lib/ledger.mjs'
import { canonical, fnv1a } from '../lib/plan-digest.mjs'
import { revParse, specPath } from '../lib/store.mjs'
import { seedTree } from './harness/seed-tree.mjs'

const APPROVAL_CLI = fileURLToPath(new URL('../lib/approval.mjs', import.meta.url))
const BOUNDARY_CLI = fileURLToPath(new URL('../lib/boundary.mjs', import.meta.url))
const FIXTURES = fileURLToPath(new URL('./fixtures/spec/', import.meta.url))

const E = 'e1'
const DRAFT = readFileSync(join(FIXTURES, 'root.md'), 'utf8').replace(/\r\n/g, '\n')
const BLOCKING = DRAFT.split('\n').find((l) => l.startsWith('- **blocking:**'))
const BLOCKING_QUESTION = BLOCKING.slice('- **blocking:**'.length).trim()
const ROOT = DRAFT.replace(BLOCKING + '\n', '')
const EDITED = ROOT.replace('Local, and writable', 'Local and writable')
const EFFORT_BRANCH = 'agentics/' + E
const INTO = 'main'

const temp = (t, name) => {
  const dir = mkdtempSync(join(tmpdir(), 'agentics-' + name + '-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// ------------------------------------------------------------------ the user's word

/** A transcript line of one AskUserQuestion answer, shaped as the host writes it. */
const answerLine = (question, answer) => JSON.stringify({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't-x', content: 'answered' }] },
  toolUseResult: { questions: [{ question }], answers: { [question]: answer } },
})

/** A session whose transcript records `answers` ([question, answer] pairs, oldest first): its env. */
function session(t, answers) {
  const config = temp(t, 'acts-config')
  const id = randomUUID()
  const folder = join(config, 'projects', 'some-project')
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, id + '.jsonl'), answers.map(([q, a]) => answerLine(q, a) + '\n').join(''))
  return { CLAUDE_CODE_SESSION_ID: id, CLAUDE_CONFIG_DIR: config }
}

const askedAbout = (token) => '1/1. Go ahead? ' + token

/** A terminal: `ask` records each prompt, runs `before` (which may change the world), returns `typed`. */
function terminal(typed, before = () => {}) {
  const prompts = []
  const ask = async (prompt) => {
    prompts.push(prompt)
    before()
    return typed
  }
  return { opts: { env: {}, stdinIsTTY: true, ask }, prompts }
}

const nobody = () => ({ env: {}, stdinIsTTY: false, ask: async () => { throw new Error('nobody may be asked') } })

const refusedAs = (out, kind) => {
  assert.equal(out.ok, false, JSON.stringify(out))
  assert.equal(out.error && out.error.kind, kind, JSON.stringify(out.error))
}

const childEnv = (own = {}) => {
  const env = { ...process.env, NODE_TEST_CONTEXT: '' }
  delete env.CLAUDE_CODE_SESSION_ID
  delete env.CLAUDE_CONFIG_DIR
  return { ...env, ...own }
}
const runCli = (cli, args, own) => JSON.parse(execFileSync(process.execPath, [cli, ...args], {
  encoding: 'utf8', env: childEnv(own), stdio: ['pipe', 'pipe', 'pipe'], input: '', timeout: 30_000,
}))
// The land CLI's result: its payload when it prints an envelope, else what it prints.
const landResult = (printed) => (printed && typeof printed === 'object' && 'payload' in printed ? printed.payload : printed)

// ------------------------------------------------------------------ specs

function specRepo(t, text) {
  const repo = temp(t, 'acts-spec')
  if (text !== undefined) writeSpec(repo, text)
  return repo
}
function writeSpec(repo, text) {
  mkdirSync(dirname(specPath(repo, E, '.')), { recursive: true })
  writeFileSync(specPath(repo, E, '.'), text)
}
const approvedLines = (repo) => readLog(repo, E, 'ledger').entries.filter((l) => l.kind === 'approved')

// ------------------------------------------------------------------ land repositories

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + r.stderr)
  return r.stdout.trim()
}

/** A repository on `main` with one commit; with `effort`, `agentics/e1` one commit ahead. */
function landRepo(t, { effort = true } = {}) {
  const dir = temp(t, 'acts-land')
  git(dir, 'init', '-q', '-b', INTO)
  git(dir, 'config', 'user.email', 't@example.com')
  git(dir, 'config', 'user.name', 'T')
  writeFileSync(join(dir, 'README.md'), 'hello\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'base')
  if (effort) {
    git(dir, 'checkout', '-q', '-b', EFFORT_BRANCH)
    writeFileSync(join(dir, 'feature.txt'), 'the effort\n')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'effort work')
    git(dir, 'checkout', '-q', INTO)
  }
  return dir
}

/** Move the effort head one commit on, leaving the checkout alone. The new head. */
function moveEffortHead(repo) {
  const head = revParse(repo, 'refs/heads/' + EFFORT_BRANCH)
  const later = git(repo, 'commit-tree', head + '^{tree}', '-p', head, '-m', 'later')
  git(repo, 'update-ref', 'refs/heads/' + EFFORT_BRANCH, later)
  return later
}

const landedEvents = (repo) => readLog(repo, E, 'events').entries.filter((e) => e.kind === 'landed')
const holds = (repo, head, sha) => spawnSync('git', ['-C', repo, 'merge-base', '--is-ancestor', sha, head]).status === 0
const landToken = (repo) => actToken({ act: 'land', effort: E, hash: revParse(repo, 'refs/heads/' + EFFORT_BRANCH) })

// ================================================================== approveAct

test('approveAct records the approval, by the user, when the session chose Approve on the token', async (t) => {
  const repo = specRepo(t, ROOT)
  const { token, hash } = approvalState(repo, E, '.')
  const env = session(t, [[askedAbout(token), 'Approve']])
  const out = await approveAct(repo, E, '.', { env, stdinIsTTY: false })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.ok(Number.isInteger(out.seq))
  assert.equal(out.hash, hash)
  const lines = approvedLines(repo)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].hash, hash)
  assert.equal(lines[0].by, 'user')
  assert.equal(approvalState(repo, E, '.').state, 'approved')
})

test('approveAct refuses not_approved when the session chose Change it, recording nothing', async (t) => {
  const repo = specRepo(t, ROOT)
  const env = session(t, [[askedAbout(approvalState(repo, E, '.').token), 'Change it']])
  refusedAs(await approveAct(repo, E, '.', { env, stdinIsTTY: false }), 'not_approved')
  assert.equal(approvedLines(repo).length, 0)
})

test('approveAct refuses answer_unverifiable with no session and no console, recording nothing', async (t) => {
  const repo = specRepo(t, ROOT)
  refusedAs(await approveAct(repo, E, '.', nobody()), 'answer_unverifiable')
  assert.equal(approvedLines(repo).length, 0)
})

test('approveAct records the approval by the terminal when the token is typed back', async (t) => {
  const repo = specRepo(t, ROOT)
  const { token, hash } = approvalState(repo, E, '.')
  const { opts, prompts } = terminal(token)
  const out = await approveAct(repo, E, '.', opts)
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(prompts.length, 1)
  assert.ok(prompts[0].includes(token), prompts[0])
  const lines = approvedLines(repo)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].hash, hash)
  assert.equal(lines[0].by, 'terminal')
})

test('a mistyped token at the terminal is refused not_approved, recording nothing', async (t) => {
  const repo = specRepo(t, ROOT)
  const { token } = approvalState(repo, E, '.')
  const last = token.slice(-1)
  const mistyped = token.slice(0, -1) + (last === '0' ? '1' : '0')
  const { opts } = terminal(mistyped)
  refusedAs(await approveAct(repo, E, '.', opts), 'not_approved')
  assert.equal(approvedLines(repo).length, 0)
})

test('an Approve given to the token of an earlier text is refused not_approved, recording nothing', async (t) => {
  const repo = specRepo(t, ROOT)
  const earlier = approvalState(repo, E, '.').token
  const env = session(t, [[askedAbout(earlier), 'Approve']])
  writeSpec(repo, EDITED)
  assert.notEqual(approvalState(repo, E, '.').token, earlier, 'the edit moves the token')
  refusedAs(await approveAct(repo, E, '.', { env, stdinIsTTY: false }), 'not_approved')
  assert.equal(approvedLines(repo).length, 0)
})

test('a spec edited while the user is asked is refused spec_changed, recording nothing', async (t) => {
  const repo = specRepo(t, ROOT)
  const asked = approvalState(repo, E, '.').token
  const { opts, prompts } = terminal(asked, () => writeSpec(repo, EDITED))
  const out = await approveAct(repo, E, '.', opts)
  assert.equal(prompts.length, 1)
  refusedAs(out, 'spec_changed')
  assert.ok(out.error.message.length > 0, JSON.stringify(out.error))
  assert.equal(approvedLines(repo).length, 0)
})

test('with no spec there is no token: approveAct refuses no_token and asks nobody', async (t) => {
  const repo = specRepo(t)
  assert.equal(approvalState(repo, E, '.').token, '')
  const env = session(t, [['Approve the spec as it stands?', 'Approve']])
  refusedAs(await approveAct(repo, E, '.', { env, stdinIsTTY: false }), 'no_token')
  const { opts, prompts } = terminal('approve .@')
  refusedAs(await approveAct(repo, E, '.', opts), 'no_token')
  assert.equal(prompts.length, 0, 'nobody is asked to confirm an empty token')
  assert.equal(approvedLines(repo).length, 0)
})

test('approveAct returns what recordApproval refuses once the word is confirmed', async (t) => {
  const repo = specRepo(t, DRAFT)
  const env = session(t, [[askedAbout(approvalState(repo, E, '.').token), 'Approve']])
  const out = await approveAct(repo, E, '.', { env, stdinIsTTY: false })
  assert.equal(out.ok, false, JSON.stringify(out))
  assert.equal(typeof out.error, 'string', JSON.stringify(out.error))
  assert.ok(out.error.includes(BLOCKING_QUESTION), out.error)
  assert.equal(approvedLines(repo).length, 0)
})

// ================================================================== recordApproval's hash

test('recordApproval given the hash the spec is at records as before', (t) => {
  const repo = specRepo(t, ROOT)
  const { hash } = approvalState(repo, E, '.')
  const out = recordApproval(repo, E, '.', { hash })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.hash, hash)
  const lines = approvedLines(repo)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].hash, hash)
  assert.equal(lines[0].by, 'user')
})

test('recordApproval refuses spec_changed when the spec is not at the hash it is given', (t) => {
  const repo = specRepo(t, ROOT)
  const before = approvalState(repo, E, '.').hash
  writeSpec(repo, EDITED)
  for (const hash of [before, '']) {
    const out = recordApproval(repo, E, '.', { hash })
    refusedAs(out, 'spec_changed')
    assert.ok(out.error.message.length > 0, JSON.stringify(hash) + ': ' + JSON.stringify(out.error))
  }
  assert.equal(approvedLines(repo).length, 0)
})

// ================================================================== land and landAct

test("land's check carries the token of the effort head", (t) => {
  const repo = landRepo(t)
  const head = revParse(repo, 'refs/heads/' + EFFORT_BRANCH)
  const check = land(repo, E, 'check')
  assert.equal(check.ok, true)
  assert.equal(check.token, actToken({ act: 'land', effort: E, hash: head }))
  assert.equal(check.token, 'land ' + E + '@' + head.slice(0, 8))
})

test('over an effort already landed, the check carries the token with no head', (t) => {
  const repo = landRepo(t)
  const landed = land(repo, E, 'merge')
  assert.equal(landed.ok, true, JSON.stringify(landed.error))
  assert.equal(revParse(repo, 'refs/heads/' + EFFORT_BRANCH), '', 'the landing swept its branch')
  const check = land(repo, E, 'check')
  assert.equal(check.token, actToken({ act: 'land', effort: E, hash: '' }))
  assert.ok(check.token.endsWith(E + '@'), check.token)
})

test('landAct merges on a confirmed Land and records landed by the user', async (t) => {
  const repo = landRepo(t)
  const effortHead = revParse(repo, 'refs/heads/' + EFFORT_BRANCH)
  const env = session(t, [[askedAbout(land(repo, E, 'check').token), 'Land']])
  const out = await landAct(repo, E, { env, stdinIsTTY: false })
  assert.equal(out.ok, true, JSON.stringify(out.error))
  const head = revParse(repo, 'HEAD')
  assert.equal(out.merged_sha, head)
  assert.ok(holds(repo, head, effortHead), 'the new HEAD holds the effort head')
  const events = landedEvents(repo)
  assert.equal(events.length, 1)
  assert.equal(events[0].into, INTO)
  assert.equal(events[0].merged_sha, head)
  assert.equal(events[0].by, 'user')
})

test('landAct refuses without a confirmed Land and merges nothing', async (t) => {
  const repo = landRepo(t)
  const before = revParse(repo, 'HEAD')
  const env = session(t, [[askedAbout(land(repo, E, 'check').token), 'Not yet']])
  refusedAs(await landAct(repo, E, { env, stdinIsTTY: false }), 'not_approved')
  assert.equal(revParse(repo, 'HEAD'), before)
  assert.equal(landedEvents(repo).length, 0)
})

test('landAct refuses answer_unverifiable with no session and no console, merging nothing', async (t) => {
  const repo = landRepo(t)
  const before = revParse(repo, 'HEAD')
  refusedAs(await landAct(repo, E, nobody()), 'answer_unverifiable')
  assert.equal(revParse(repo, 'HEAD'), before)
  assert.equal(landedEvents(repo).length, 0)
})

test('landAct at a terminal merges on the token typed back, by the terminal', async (t) => {
  const repo = landRepo(t)
  const token = land(repo, E, 'check').token
  const { opts, prompts } = terminal(token)
  const out = await landAct(repo, E, opts)
  assert.equal(out.ok, true, JSON.stringify(out.error))
  assert.equal(prompts.length, 1)
  assert.ok(prompts[0].includes(token), prompts[0])
  const head = revParse(repo, 'HEAD')
  assert.equal(out.merged_sha, head)
  const events = landedEvents(repo)
  assert.equal(events.length, 1)
  assert.equal(events[0].merged_sha, head)
  assert.equal(events[0].by, 'terminal')
})

test('a Land given to the token of an earlier effort head is refused not_approved, merging nothing', async (t) => {
  const repo = landRepo(t)
  const before = revParse(repo, 'HEAD')
  const earlier = land(repo, E, 'check').token
  const env = session(t, [[askedAbout(earlier), 'Land']])
  moveEffortHead(repo)
  assert.notEqual(land(repo, E, 'check').token, earlier, 'the move changes the token')
  refusedAs(await landAct(repo, E, { env, stdinIsTTY: false }), 'not_approved')
  assert.equal(revParse(repo, 'HEAD'), before)
  assert.equal(landedEvents(repo).length, 0)
})

test('an effort head that moves while the user is asked is refused head_moved, merging nothing', async (t) => {
  const repo = landRepo(t)
  const before = revParse(repo, 'HEAD')
  const asked = land(repo, E, 'check').token
  const { opts, prompts } = terminal(asked, () => moveEffortHead(repo))
  const out = await landAct(repo, E, opts)
  assert.equal(prompts.length, 1)
  refusedAs(out, 'head_moved')
  assert.ok(out.error.message.length > 0, JSON.stringify(out.error))
  assert.equal(revParse(repo, 'HEAD'), before)
  assert.equal(landedEvents(repo).length, 0)
})

test('over an effort already landed, a confirmed answer to its token sweeps again', async (t) => {
  const repo = landRepo(t)
  assert.equal(land(repo, E, 'merge').ok, true)
  const head = revParse(repo, 'HEAD')
  git(repo, 'branch', EFFORT_BRANCH + '--late')
  const token = land(repo, E, 'check').token
  assert.equal(token, actToken({ act: 'land', effort: E, hash: '' }))
  const env = session(t, [[askedAbout(token), 'Land']])
  const out = await landAct(repo, E, { env, stdinIsTTY: false })
  assert.equal(out.ok, true, JSON.stringify(out.error))
  assert.equal(out.already, true)
  assert.ok(out.removed.includes(EFFORT_BRANCH + '--late'), JSON.stringify(out.removed))
  assert.equal(revParse(repo, 'HEAD'), head)
  assert.equal(landedEvents(repo).length, 1)
})

test('with no effort branch and nothing landed, a confirmed Land merges nothing', async (t) => {
  const repo = landRepo(t, { effort: false })
  const before = revParse(repo, 'HEAD')
  const token = land(repo, E, 'check').token
  assert.equal(token, '', 'no effort branch: no token to confirm')
  const env = session(t, [[askedAbout(token), 'Land']])
  const out = await landAct(repo, E, { env, stdinIsTTY: false })
  assert.equal(out.ok, false, JSON.stringify(out))
  assert.equal(out.error.kind, 'no_effort_branch')
  assert.ok(out.error.message.includes(EFFORT_BRANCH), out.error.message)
  assert.equal(revParse(repo, 'HEAD'), before)
  assert.equal(landedEvents(repo).length, 0)
})

test('an in-process merge needs no word and records landed by the user unless told otherwise', (t) => {
  const byDefault = landRepo(t)
  const out = land(byDefault, E, 'merge')
  assert.equal(out.ok, true, JSON.stringify(out.error))
  const [first] = landedEvents(byDefault)
  assert.equal(first.merged_sha, revParse(byDefault, 'HEAD'))
  assert.equal(first.by, 'user')

  const told = landRepo(t)
  assert.equal(land(told, E, 'merge', { by: 'terminal' }).ok, true)
  const events = landedEvents(told)
  assert.equal(events.length, 1)
  assert.equal(events[0].by, 'terminal')
})

// ================================================================== the CLIs

const approveArgs = (repo) => ['approve', '--repo', repo, '--effort', E, '--folder', '.']
const landArgs = (repo, action) => ['land', '--repo', repo, '--effort', E, '--action', action]

test("the approve CLI approves on the session's Approve and prints its envelope", (t) => {
  const repo = specRepo(t, ROOT)
  const own = session(t, [[askedAbout(approvalState(repo, E, '.').token), 'Approve']])
  const printed = runCli(APPROVAL_CLI, approveArgs(repo), own)
  assert.equal(printed.payload.ok, true, JSON.stringify(printed.payload))
  assert.equal(printed.payload_digest, fnv1a(canonical(printed.payload)))
  const lines = approvedLines(repo)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].by, 'user')
})

test("the land merge CLI merges on the session's Land", (t) => {
  const repo = landRepo(t)
  const own = session(t, [[askedAbout(land(repo, E, 'check').token), 'Land']])
  const out = landResult(runCli(BOUNDARY_CLI, landArgs(repo, 'merge'), own))
  assert.equal(out.ok, true, JSON.stringify(out.error))
  const events = landedEvents(repo)
  assert.equal(events.length, 1)
  assert.equal(events[0].merged_sha, revParse(repo, 'HEAD'))
  assert.equal(events[0].by, 'user')
})

// ================================================================== the CLIs at a console

/** Run `cli` with no session, its stdin a pipe that reads as a console, holding `typed`. */
function atConsole(t, cli, args, typed) {
  const preload = join(temp(t, 'acts-tty'), 'tty.mjs')
  writeFileSync(preload, 'process.stdin.isTTY = true\n')
  return spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, cli, ...args], {
    encoding: 'utf8', env: childEnv(), input: typed, timeout: 30_000,
  })
}

test('the approve CLI at a console refuses not_approved when stdin closes before a line, recording nothing', { timeout: 60_000 }, (t) => {
  const repo = specRepo(t, ROOT)
  const run = atConsole(t, APPROVAL_CLI, approveArgs(repo), '')
  assert.equal(run.status, 0, run.stderr)
  const lines = run.stdout.split('\n').filter(Boolean)
  assert.equal(lines.length, 1, run.stdout)
  const printed = JSON.parse(lines[0])
  assert.equal(printed.payload_digest, fnv1a(canonical(printed.payload)))
  refusedAs(printed.payload, 'not_approved')
  assert.equal(approvedLines(repo).length, 0)
})

test('the land merge CLI at a console refuses not_approved when stdin closes before a line, merging nothing', { timeout: 60_000 }, (t) => {
  const repo = landRepo(t)
  const before = revParse(repo, 'HEAD')
  const run = atConsole(t, BOUNDARY_CLI, landArgs(repo, 'merge'), '')
  assert.equal(run.status, 0, run.stderr)
  refusedAs(landResult(JSON.parse(run.stdout)), 'not_approved')
  assert.equal(revParse(repo, 'HEAD'), before)
  assert.equal(landedEvents(repo).length, 0)
})

test('the approve CLI at a console approves on the token typed back, by the terminal', { timeout: 60_000 }, (t) => {
  const repo = specRepo(t, ROOT)
  const { token, hash } = approvalState(repo, E, '.')
  const run = atConsole(t, APPROVAL_CLI, approveArgs(repo), token + '\n')
  assert.equal(run.status, 0, run.stderr)
  const printed = JSON.parse(run.stdout)
  assert.equal(printed.payload.ok, true, JSON.stringify(printed.payload))
  const lines = approvedLines(repo)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].hash, hash)
  assert.equal(lines[0].by, 'terminal')
})

test('the land merge CLI at a console merges on the token typed back, by the terminal', { timeout: 60_000 }, (t) => {
  const repo = landRepo(t)
  const run = atConsole(t, BOUNDARY_CLI, landArgs(repo, 'merge'), landToken(repo) + '\n')
  assert.equal(run.status, 0, run.stderr)
  const out = landResult(JSON.parse(run.stdout))
  assert.equal(out.ok, true, JSON.stringify(out.error))
  const events = landedEvents(repo)
  assert.equal(events.length, 1)
  assert.equal(events[0].merged_sha, revParse(repo, 'HEAD'))
  assert.equal(events[0].by, 'terminal')
})

// ================================================================== the word binds the head it named

/**
 * Move the effort head one commit on at `land`'s `git status`, after it reads the head and before
 * it merges: a one-shot fsmonitor hook, outside the working tree so the tree stays clean. The later
 * commit.
 */
function moveEffortHeadAtStatus(t, repo) {
  const head = revParse(repo, 'refs/heads/' + EFFORT_BRANCH)
  const later = git(repo, 'commit-tree', head + '^{tree}', '-p', head, '-m', 'later')
  const at = repo.replace(/\\/g, '/')
  const hook = join(temp(t, 'acts-hook'), 'fsmonitor.sh')
  writeFileSync(hook, [
    '#!/bin/sh',
    'git -C "' + at + '" config --unset core.fsmonitor',
    'git -C "' + at + '" update-ref refs/heads/' + EFFORT_BRANCH + ' ' + later,
    'exit 1',
    '',
  ].join('\n'))
  chmodSync(hook, 0o755)
  git(repo, 'config', 'core.fsmonitor', hook.replace(/\\/g, '/'))
  return later
}

test('an effort head that moves after land reads it never puts the later commit into the branch', (t) => {
  const repo = landRepo(t)
  const before = revParse(repo, 'HEAD')
  const askedHead = revParse(repo, 'refs/heads/' + EFFORT_BRANCH)
  const later = moveEffortHeadAtStatus(t, repo)
  const out = land(repo, E, 'merge', { askedHead })
  const head = revParse(repo, 'HEAD')
  assert.ok(!holds(repo, head, later), 'the user\'s HEAD does not hold the later commit')
  assert.equal(spawnSync('git', ['-C', repo, 'config', 'core.fsmonitor']).status, 1, 'the hook ran')
  if (out.ok) {
    const events = landedEvents(repo)
    assert.equal(events.length, 1)
    assert.equal(events[0].merged_sha, head)
    assert.ok(holds(repo, head, askedHead), 'the landing holds the head the user was asked about')
  } else {
    assert.equal(landedEvents(repo).length, 0)
    assert.equal(head, before)
  }
})

test('a moved effort head is refused head_moved before a dirty tree is', (t) => {
  const repo = landRepo(t)
  const before = revParse(repo, 'HEAD')
  const askedHead = revParse(repo, 'refs/heads/' + EFFORT_BRANCH)
  moveEffortHead(repo)
  writeFileSync(join(repo, 'stray.txt'), 'dirty\n')
  const out = land(repo, E, 'merge', { askedHead })
  assert.equal(out.ok, false, JSON.stringify(out))
  assert.equal(out.error.kind, 'head_moved', JSON.stringify(out.error))
  assert.equal(revParse(repo, 'HEAD'), before)
  assert.equal(landedEvents(repo).length, 0)
})

test('a moved effort head is refused head_moved before an open escalation is', (t) => {
  const repo = landRepo(t)
  const before = revParse(repo, 'HEAD')
  const askedHead = revParse(repo, 'refs/heads/' + EFFORT_BRANCH)
  moveEffortHead(repo)
  const leafA = { id: 'a', kind: 'leaf', title: 'do a', rigor: 'tdd', expects: ['a.mjs'], decisions: ['D1'], acceptance: [{ text: 'a works', check: 'node --test', decisions: ['D1'] }] }
  assert.equal(seedTree(repo, E, [{ id: '.', kind: 'composite', title: 'the change', defines: [{ id: 'D1', text: 'do it' }] }, leafA]).ok, true)
  assert.equal(append(repo, E, 'events', { kind: 'escalated', node: 'a', execution: '', reason: 'blocked', detail: '' }).ok, true)
  assert.ok(land(repo, E, 'check').open_escalations.length > 0, 'the escalation is open')
  const out = land(repo, E, 'merge', { askedHead })
  assert.equal(out.ok, false, JSON.stringify(out))
  assert.equal(out.error.kind, 'head_moved', JSON.stringify(out.error))
  assert.equal(revParse(repo, 'HEAD'), before)
  assert.equal(landedEvents(repo).length, 0)
})

// ================================================================== nobody is asked in vain

test('an empty spec file at a terminal is refused as recordApproval refuses it, asking nobody', async (t) => {
  const repo = specRepo(t, '')
  const { token, hash } = approvalState(repo, E, '.')
  assert.notEqual(token, '', 'an empty file still has a token')
  const { opts, prompts } = terminal(token)
  const out = await approveAct(repo, E, '.', opts)
  assert.equal(out.ok, false, JSON.stringify(out))
  assert.deepEqual(out, recordApproval(repo, E, '.', { by: 'terminal', hash }))
  assert.equal(prompts.length, 0, 'nobody is asked to confirm a spec that cannot be approved')
  assert.equal(approvedLines(repo).length, 0)
})

test('a spec with an open blocking question at a terminal is refused naming it, asking nobody', async (t) => {
  const repo = specRepo(t, DRAFT)
  const { opts, prompts } = terminal(approvalState(repo, E, '.').token)
  const out = await approveAct(repo, E, '.', opts)
  assert.equal(out.ok, false, JSON.stringify(out))
  assert.ok(String(out.error).includes(BLOCKING_QUESTION), out.error)
  assert.equal(prompts.length, 0, 'nobody is asked to confirm a spec that cannot be approved')
  assert.equal(approvedLines(repo).length, 0)
})

// ================================================================== a landing whose record was lost

test('over a merge with no landed record, a confirmed Land records it once, by the terminal', async (t) => {
  const repo = landRepo(t)
  git(repo, 'merge', '--no-ff', '--no-edit', EFFORT_BRANCH)
  const head = revParse(repo, 'HEAD')
  const { opts } = terminal(landToken(repo))
  const out = await landAct(repo, E, opts)
  assert.equal(out.ok, true, JSON.stringify(out.error))
  assert.equal(out.already, true)
  assert.equal(revParse(repo, 'HEAD'), head)
  const events = landedEvents(repo)
  assert.equal(events.length, 1)
  assert.equal(events[0].into, INTO)
  assert.equal(events[0].merged_sha, head)
  assert.equal(events[0].by, 'terminal')
})

test('over a merge already recorded, a confirmed Land adds no second landed record', async (t) => {
  const repo = landRepo(t)
  const effortHead = revParse(repo, 'refs/heads/' + EFFORT_BRANCH)
  assert.equal(land(repo, E, 'merge').ok, true)
  const landedHead = revParse(repo, 'HEAD')
  git(repo, 'branch', EFFORT_BRANCH, effortHead)
  const { opts } = terminal(landToken(repo))
  const out = await landAct(repo, E, opts)
  assert.equal(out.ok, true, JSON.stringify(out.error))
  assert.equal(out.already, true)
  assert.equal(landedEvents(repo).length, 1)
  assert.equal(revParse(repo, 'HEAD'), landedHead, 'the second Land merged nothing')
})
