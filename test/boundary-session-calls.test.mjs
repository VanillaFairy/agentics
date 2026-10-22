// test/boundary-session-calls.test.mjs — the session's own calls against real git: accept records the
// session's judgment of the drift an integration review found; retry and note
// name the open execution that holds the node, take no --execution, and land records a second
// landing killed before its record and refuses a check that names no commit.
//
// Design: docs/DESIGN.md#session-calls.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { acceptDrift, land, landAct } from '../lib/boundary.mjs'
import { append, readLog } from '../lib/ledger.mjs'
import { dispatchKey, executionDir, returnPath, revParse, writeJson } from '../lib/store.mjs'
import { readTree, standingReview } from '../lib/tree.mjs'
import { seedTree } from './harness/seed-tree.mjs'
import { commitIn, git, leaf, repo, root } from './harness/boundary-fixture.mjs'

const BOUNDARY = fileURLToPath(new URL('../lib/boundary.mjs', import.meta.url))
const E = 'e1'
const EFFORT_BRANCH = 'agentics/' + E
const OLDER = '20260925-120000'
const NEWER = '20260925-130000'
const NEWEST = '20260925-140000'

/** A repository on `main`, removed after the test. */
function fresh(t) {
  const r = repo()
  t.after(() => rmSync(r, { recursive: true, force: true }))
  return r
}

/** A repository whose effort holds the folder `c` with the leaf `c/a`, and the leaf `b`. */
function seeded(t) {
  const r = fresh(t)
  seedTree(r, E, [root(), { id: 'c', kind: 'composite', title: 'c', decisions: ['D1'] }, leaf('c/a', { locus: ['src/a.mjs'] }), leaf('b', { locus: ['src/b.mjs'] })])
  return r
}

/** An execution over `rootId` as its preflight leaves it; `closed` as its postflight leaves it. */
function execution(r, stamp, rootId, { closed = false } = {}) {
  const dir = executionDir(r, E, stamp)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'execution.json'), JSON.stringify({ stamp, root: rootId }))
  if (closed) append(r, E, 'state:' + stamp, { kind: 'closed', status: 'done' })
}

/** A session call through the boundary CLI, as develop runs it: what it prints. */
function call(r, verb, ...args) {
  const out = spawnSync(process.execPath, [BOUNDARY, verb, '--repo', r, '--effort', E, ...args], {
    encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: '' }, timeout: 30_000,
  })
  assert.equal(out.status, 0, out.stderr)
  return JSON.parse(out.stdout)
}

const eventsOf = (r, kind) => readTree(r, E).events.filter((e) => e.kind === kind)
const executionOf = (r, kind, id) => eventsOf(r, kind).filter((e) => e.node === id).map((e) => e.execution)
const escalate = (r, id, stamp) => append(r, E, 'events', { kind: 'escalated', node: id, execution: stamp, reason: 'blocked', detail: 'needs a key' })

// ================================================================== retry

test('retry clears the stop of each live node it names and of no other', (t) => {
  const r = seeded(t)
  execution(r, OLDER, '.')
  escalate(r, 'c/a', OLDER)
  assert.equal(readTree(r, E).status.get('c/a').status, 'escalated')
  assert.deepEqual(call(r, 'retry', '--node', 'c/a', '--node', 'nope'), { retried: ['c/a'], error: null })
  assert.notEqual(readTree(r, E).status.get('c/a').status, 'escalated')
  assert.deepEqual(eventsOf(r, 'replanned').map((e) => [e.node, e.reason, e.by]), [['c/a', 'retry_escalated', 'session']])
})

test('retry names the open execution whose root holds the node, not a later one beside it', (t) => {
  const r = seeded(t)
  execution(r, OLDER, '.')
  execution(r, NEWER, 'c')
  call(r, 'retry', '--node', 'b')
  assert.deepEqual(executionOf(r, 'replanned', 'b'), [OLDER])
})

test('retry names the latest of the open executions whose root holds the node', (t) => {
  const r = seeded(t)
  execution(r, OLDER, '.')
  execution(r, NEWER, 'c')
  call(r, 'retry', '--node', 'c/a')
  assert.deepEqual(executionOf(r, 'replanned', 'c/a'), [NEWER])
})

test('retry never names a closed execution', (t) => {
  const r = seeded(t)
  execution(r, OLDER, '.')
  execution(r, NEWEST, '.', { closed: true })
  call(r, 'retry', '--node', 'b')
  assert.deepEqual(executionOf(r, 'replanned', 'b'), [OLDER])
})

test('retry names no execution when no open one holds the node', (t) => {
  const r = seeded(t)
  call(r, 'retry', '--node', 'b')
  execution(r, NEWER, 'c')
  execution(r, NEWEST, '.', { closed: true })
  call(r, 'retry', '--node', 'b')
  assert.deepEqual(executionOf(r, 'replanned', 'b'), ['', ''])
})

test('an execution folder whose execution.json is gone holds no node', (t) => {
  const r = seeded(t)
  execution(r, OLDER, '.')
  mkdirSync(executionDir(r, E, NEWER), { recursive: true })
  call(r, 'retry', '--node', 'b')
  call(r, 'note', '--node', 'b', '--text', 'learned')
  assert.deepEqual(executionOf(r, 'replanned', 'b'), [OLDER])
  assert.deepEqual(executionOf(r, 'noted', 'b'), [OLDER])
})

test('retry refuses --execution as an unknown flag, recording nothing', (t) => {
  const r = seeded(t)
  execution(r, OLDER, '.')
  escalate(r, 'b', OLDER)
  const out = call(r, 'retry', '--execution', OLDER, '--node', 'b')
  assert.deepEqual(out.retried, [])
  assert.equal(out.error.kind, 'bad_arg')
  assert.ok(out.error.message.includes('--execution'), out.error.message)
  assert.equal(eventsOf(r, 'replanned').length, 0)
  assert.equal(readTree(r, E).status.get('b').status, 'escalated')
})

// ================================================================== note

test('note records what the session learned on the node and changes no status', (t) => {
  const r = seeded(t)
  execution(r, OLDER, '.')
  escalate(r, 'b', OLDER)
  assert.deepEqual(call(r, 'note', '--node', 'b', '--text', ' the key is in the vault '), { noted: 'b', error: null })
  assert.deepEqual(eventsOf(r, 'noted').map((e) => [e.node, e.by, e.text]), [['b', 'session', 'the key is in the vault']])
  assert.equal(readTree(r, E).status.get('b').status, 'escalated')
})

test('note names the latest open execution whose root holds the node', (t) => {
  const r = seeded(t)
  execution(r, OLDER, '.')
  execution(r, NEWER, 'c')
  execution(r, NEWEST, '.', { closed: true })
  call(r, 'note', '--node', 'c/a', '--text', 'one')
  call(r, 'note', '--node', 'b', '--text', 'two')
  assert.deepEqual(executionOf(r, 'noted', 'c/a'), [NEWER])
  assert.deepEqual(executionOf(r, 'noted', 'b'), [OLDER])
})

test('note names no execution when no open one holds the node', (t) => {
  const r = seeded(t)
  execution(r, NEWER, 'c')
  call(r, 'note', '--node', 'b', '--text', 'learned')
  assert.deepEqual(executionOf(r, 'noted', 'b'), [''])
})

test('note refuses --execution as an unknown flag, recording nothing', (t) => {
  const r = seeded(t)
  execution(r, OLDER, '.')
  const out = call(r, 'note', '--execution', OLDER, '--node', 'b', '--text', 'learned')
  assert.equal(out.noted, '')
  assert.equal(out.error.kind, 'bad_arg')
  assert.ok(out.error.message.includes('--execution'), out.error.message)
  assert.equal(eventsOf(r, 'noted').length, 0)
})

test('an unknown flag where a value was due is the flag named, not the word after it', (t) => {
  const r = seeded(t)
  execution(r, OLDER, '.')
  const out = call(r, 'note', '--node', '--execution', OLDER, '--text', 'learned')
  assert.equal(out.error.kind, 'bad_arg')
  assert.ok(out.error.message.includes('--execution'), out.error.message)
  assert.ok(!out.error.message.includes(OLDER), out.error.message)
  assert.equal(eventsOf(r, 'noted').length, 0)
})

test('a text that starts with -- is the text of note, not a flag', (t) => {
  const r = seeded(t)
  execution(r, OLDER, '.')
  const out = call(r, 'note', '--node', 'b', '--text', '--force is wrong')
  assert.deepEqual([out.noted, out.error], ['b', null], JSON.stringify(out))
  assert.deepEqual(eventsOf(r, 'noted').map((e) => e.text), ['--force is wrong'])
})

test('note refuses a node that is not live and a text that says nothing, recording nothing', (t) => {
  const r = seeded(t)
  assert.match(call(r, 'note', '--node', 'nope', '--text', 'x').error, /no live node/)
  assert.match(call(r, 'note', '--node', 'b').error, /--text/)
  assert.match(call(r, 'note', '--node', 'b', '--text', '   ').error, /--text/)
  assert.equal(eventsOf(r, 'noted').length, 0)
})

// ================================================================== land

const landedEvents = (r) => readLog(r, E, 'events').entries.filter((e) => e.kind === 'landed')

/** The effort branch cut from the checkout's head with one commit of `file`; its head. */
function effortWork(r, file) {
  git(r, 'checkout', '-q', '-b', EFFORT_BRANCH)
  commitIn(r, { [file]: file + '\n' }, 'work in ' + file)
  git(r, 'checkout', '-q', 'main')
  return revParse(r, 'refs/heads/' + EFFORT_BRANCH)
}

/** A terminal that types back the token it is shown, and records each prompt. */
function typesBack() {
  const prompts = []
  const ask = async (prompt) => {
    prompts.push(prompt)
    return prompt.match(/land \S+@\S*/)[0]
  }
  return { opts: { env: {}, stdinIsTTY: true, ask }, prompts }
}

test('a second landing killed between its merge and its record is recorded by the next confirmed land', async (t) => {
  const r = fresh(t)
  effortWork(r, 'first.txt')
  assert.equal(land(r, E, 'merge').ok, true)
  const second = effortWork(r, 'second.txt')
  git(r, 'merge', '--no-ff', '--no-edit', '-m', 'Merge agentics effort ' + E, second)
  assert.equal(landedEvents(r).length, 1, 'the second merge left no record')
  const { opts, prompts } = typesBack()
  const out = await landAct(r, E, opts)
  assert.equal(out.ok, true, JSON.stringify(out.error))
  assert.equal(out.already, true)
  assert.equal(prompts.length, 1)
  const events = landedEvents(r)
  assert.equal(events.length, 2)
  assert.equal(events[1].merged_sha, revParse(r, 'HEAD'))
  assert.equal(events[1].by, 'terminal')
})

test('a land whose latest record already holds the effort head records nothing more', (t) => {
  const r = fresh(t)
  const head = effortWork(r, 'first.txt')
  assert.equal(land(r, E, 'merge').ok, true)
  git(r, 'branch', EFFORT_BRANCH, head)
  const out = land(r, E, 'merge')
  assert.equal(out.ok, true, JSON.stringify(out.error))
  assert.equal(out.already, true)
  assert.equal(landedEvents(r).length, 1)
})

test('the check over no effort branch and nothing landed is refused no_effort_branch, with no token', (t) => {
  const r = fresh(t)
  const out = land(r, E, 'check')
  assert.equal(out.ok, false, JSON.stringify(out))
  assert.equal(out.error.kind, 'no_effort_branch')
  assert.ok(out.error.message.includes(EFFORT_BRANCH), out.error.message)
  assert.equal(out.token, '')
})

test('the check over an effort landed and swept still stands', (t) => {
  const r = fresh(t)
  effortWork(r, 'first.txt')
  assert.equal(land(r, E, 'merge').ok, true)
  assert.equal(revParse(r, 'refs/heads/' + EFFORT_BRANCH), '', 'the landing swept its branch')
  const out = land(r, E, 'check')
  assert.equal(out.ok, true, JSON.stringify(out.error))
  assert.equal(out.token, 'land ' + E + '@')
})

test('landAct over no effort branch returns the check refusal and asks nobody', async (t) => {
  const r = fresh(t)
  const before = revParse(r, 'HEAD')
  const out = await landAct(r, E, { env: {}, stdinIsTTY: true, ask: async () => { throw new Error('nobody may be asked') } })
  assert.equal(out.ok, false, JSON.stringify(out))
  assert.equal(out.error.kind, 'no_effort_branch')
  assert.equal(revParse(r, 'HEAD'), before)
  assert.equal(landedEvents(r).length, 0)
})

test('a merge over no effort branch and nothing landed is refused no_effort_branch', (t) => {
  const r = fresh(t)
  const out = land(r, E, 'merge')
  assert.equal(out.ok, false, JSON.stringify(out))
  assert.equal(out.error.kind, 'no_effort_branch')
  assert.equal(landedEvents(r).length, 0)
})

test('a session call refuses a value that is not a handle and a text past its line, recording nothing', (t) => {
  const r = seeded(t)
  for (const out of [call(r, 'note', '--node', 'b', '--text', 'one\ntwo'), call(r, 'note', '--node', 'b', '--text', 'x'.repeat(301))]) {
    assert.deepEqual([out.noted, out.error.kind], ['', 'args_unreadable'])
  }
  const retried = call(r, 'retry', '--node', 'a b')
  assert.deepEqual([retried.retried, retried.error.kind], [[], 'args_unreadable'])
  const landed = call(r, 'land', '--action', 'check now')
  assert.deepEqual([landed.ok, landed.error.kind], [false, 'args_unreadable'])
  assert.equal(eventsOf(r, 'noted').length, 0)
})

test('a note past one line is refused naming --text-file, and --text-file records the file\'s text whole', (t) => {
  const r = seeded(t)
  const long = ['what stopped it:', 'the vault key was rotated', 'y'.repeat(400)].join('\n')
  const refused = call(r, 'note', '--node', 'b', '--text', long.replace(/\n/g, ' '))
  assert.deepEqual([refused.noted, refused.error.kind], ['', 'args_unreadable'])
  assert.match(refused.error.message, /--text-file/)
  assert.equal(eventsOf(r, 'noted').length, 0)

  const file = join(r, 'note.txt')
  writeFileSync(file, long)
  assert.deepEqual(call(r, 'note', '--node', 'b', '--text-file', file), { noted: 'b', error: null })
  assert.deepEqual(eventsOf(r, 'noted').map((e) => e.text), [long], 'the text, not the path')
})

test('a note by --text and --text-file is refused bad_args, and by a file that is none unknown_file', (t) => {
  const r = seeded(t)
  const file = join(r, 'note.txt')
  writeFileSync(file, 'x')
  assert.equal(call(r, 'note', '--node', 'b', '--text', 'y', '--text-file', file).error.kind, 'bad_args')
  assert.equal(call(r, 'note', '--node', 'b', '--text-file', join(r, 'missing.txt')).error.kind, 'unknown_file')
  assert.equal(eventsOf(r, 'noted').length, 0)
})

// ================================================================== accept

const REVIEW_THREAD = dispatchKey({ node: 'c', role: 'reviewer', thread: 'integration:c:1', round: 1 })
const drift = (text, ruling = 'under') => ({ claim: text, ruling })
const settle = (r, id) => readTree(r, E).status.get(id)
const accepted = (r) => eventsOf(r, 'claims').filter((e) => e.by === 'session')

/**
 * Folder `c` with its only child merged, reviewed at head `h`: the review's `claims` event, its
 * stored return and the park it earned, each said the reviewer's dispatch. `park: null` records none.
 */
function judged(t, { claims = [drift('names match'), drift('shape matches', 'deviates'), drift('it builds', 'met')], findings = [], park = 'integration_critical', review = 'done' } = {}) {
  const r = seeded(t)
  append(r, E, 'events', { kind: 'merged', node: 'c/a', execution: OLDER, into: 'agentics/e1/c', merged_sha: 'a'.repeat(40), head_sha: 'a'.repeat(40) })
  writeJson(returnPath(executionDir(r, E, OLDER), REVIEW_THREAD), { units: [], findings, fix_rulings: [], claims, notes: '' })
  append(r, E, 'events', { kind: 'claims', node: 'c', execution: OLDER, head_sha: 'h', review, claims, said: REVIEW_THREAD })
  if (park) append(r, E, 'events', { kind: 'parked', node: 'c', execution: OLDER, return: park, question: 'q', said: REVIEW_THREAD })
  return r
}
const take = (...texts) => ({ claims: texts.map((claim) => ({ claim, why: 'a name, no behaviour behind it' })) })

test('accepting every drift claim records the acceptance with its reason and the folder reads integrated', (t) => {
  const r = judged(t)
  assert.equal(settle(r, 'c').status, 'parked')
  const out = acceptDrift(r, E, 'c', take('names match', 'shape matches'))

  assert.deepEqual(out, { ok: true, accepted_n: 2, park: null })
  const [event] = accepted(r)
  assert.deepEqual(event.claims.map((c) => [c.claim, c.ruling]), [['names match', 'accepted'], ['shape matches', 'accepted'], ['it builds', 'met']])
  assert.deepEqual(event.accepted, [
    { claim: 'names match', was: 'under', why: 'a name, no behaviour behind it' },
    { claim: 'shape matches', was: 'deviates', why: 'a name, no behaviour behind it' },
  ])
  assert.equal(event.said, REVIEW_THREAD)
  assert.equal(event.head_sha, 'h')
  assert.equal(event.execution, OLDER)
  assert.equal(settle(r, 'c').status, 'integrated', 'the park the review raised is cleared and the acceptance stands')
  const tree = readTree(r, E)
  assert.equal(standingReview(tree.nodes, tree.events, 'c').seq, event.seq)
})

test('accepting some drift claims leaves the folder parked, on a fresh park of the same review', (t) => {
  const r = judged(t)
  const out = acceptDrift(r, E, 'c', take('names match'))

  assert.deepEqual(out, { ok: true, accepted_n: 1, park: 'integration_critical' })
  const now = settle(r, 'c')
  assert.equal(now.status, 'parked')
  assert.ok(now.last.question.includes('shape matches') && !now.last.question.includes('names match'), now.last.question)
  assert.equal(now.last.said, REVIEW_THREAD)
  assert.ok(now.last.seq > accepted(r)[0].seq, 'the park follows the acceptance that earned it')

  const rest = acceptDrift(r, E, 'c', take('shape matches'))
  assert.equal(rest.park, null)
  assert.equal(settle(r, 'c').status, 'integrated')
  assert.deepEqual(accepted(r).at(-1).accepted.map((a) => a.claim), ['names match', 'shape matches'], 'the second acceptance keeps the first')
})

test('what the acceptance leaves undecided earns its own park, never a pass', (t) => {
  const r = judged(t, { claims: [drift('names match'), { claim: 'latency stays flat', ruling: 'cant_tell' }] })
  const out = acceptDrift(r, E, 'c', take('names match'))
  assert.equal(out.park, 'cant_tell')
  assert.equal(settle(r, 'c').last.return, 'cant_tell')
})

test("accept refuses where the verdict is not the session's, recording nothing", (t) => {
  const outrun = () => {
    const r = judged(t)
    append(r, E, 'events', { kind: 'merged', node: 'c/a', execution: OLDER, merged_sha: 'b'.repeat(40) })
    return r
  }
  const otherDispatch = () => {
    const r = judged(t, { park: null })
    append(r, E, 'events', { kind: 'parked', node: 'c', execution: OLDER, return: 'integration_critical', question: 'q', said: 'someone.else' })
    return r
  }
  const returnGone = () => {
    const r = judged(t)
    rmSync(returnPath(executionDir(r, E, OLDER), REVIEW_THREAD))
    return r
  }
  const critical = { id: 'F1', severity: 'critical', claim: 'broken', evidence: 'a:1', failure_scenario: 'x' }
  const odd = (ruling) => judged(t, { claims: [{ claim: 'k', ruling }, drift('names match')] })
  const cases = [
    ['a leaf', judged(t), 'c/a', take('names match'), 'not_a_folder'],
    ['a node that does not exist', judged(t), 'nope', take('names match'), 'not_a_folder'],
    ['a folder never reviewed', seeded(t), 'c', take('names match'), 'no_review'],
    ['a review not earned', judged(t, { claims: [], park: null, review: 'not_earned' }), 'c', take('names match'), 'no_review'],
    ['a review the head outran', outrun(), 'c', take('names match'), 'no_review'],
    ['a folder that is not parked', judged(t, { park: null }), 'c', take('names match'), 'not_a_drift_park'],
    ['a park of another class', judged(t, { park: 'spec_defect' }), 'c', take('names match'), 'not_a_drift_park'],
    ['a park of another dispatch', otherDispatch(), 'c', take('names match'), 'not_a_drift_park'],
    ['a review with a critical finding', judged(t, { findings: [critical] }), 'c', take('names match'), 'critical_finding'],
    ['a review whose return is gone', returnGone(), 'c', take('names match'), 'no_return'],
    ['a claim the review did not make', judged(t), 'c', take('names are the same'), 'not_acceptable'],
    ['a claim ruled met', judged(t), 'c', take('it builds'), 'not_acceptable'],
    ['a claim ruled spec_defect', odd('spec_defect'), 'c', take('k'), 'not_acceptable'],
    ['a claim ruled cant_tell', odd('cant_tell'), 'c', take('k'), 'not_acceptable'],
    ['a reason that says nothing', judged(t), 'c', { claims: [{ claim: 'names match', why: '  ' }] }, 'no_reason'],
    ['an empty list', judged(t), 'c', { claims: [] }, 'no_claims'],
    ['a file with no list', judged(t), 'c', { nope: 1 }, 'bad_file'],
    ['a claim listed twice', judged(t), 'c', take('names match', 'names match'), 'bad_file'],
    ['a valid claim beside an unacceptable one', judged(t), 'c', take('names match', 'it builds'), 'not_acceptable'],
  ]
  for (const [what, r, node, input, kind] of cases) {
    const before = readTree(r, E).events.length
    const out = acceptDrift(r, E, node, input)
    assert.equal(out.ok, false, what)
    assert.equal(out.error.kind, kind, what + ': ' + out.error.message)
    assert.equal(readTree(r, E).events.length, before, what + ' wrote nothing')
  }
})

test('accept through the CLI reads the claims from the file the session wrote, and refuses an unknown flag and a missing file', (t) => {
  const r = judged(t)
  const file = join(r, 'accept.json')
  writeFileSync(file, JSON.stringify(take('names match', 'shape matches')))
  assert.equal(call(r, 'accept', '--node', 'c', '--file', file).ok, true)
  assert.equal(settle(r, 'c').status, 'integrated')

  const again = judged(t)
  assert.equal(call(again, 'accept', '--node', 'c', '--file', join(again, 'nope.json')).error.kind, 'unknown_file')
  assert.equal(call(again, 'accept', '--node', 'c', '--file', file, '--execution', OLDER).error.kind, 'bad_arg')
  assert.equal(accepted(again).length, 0)
})

test('net through the CLI refuses a leaf not escalated discriminator_undecidable, an unknown flag and a missing file', (t) => {
  const r = judged(t)
  const file = join(r, 'nets.json')
  writeFileSync(file, JSON.stringify({ nets: [{ file: 'test/x.test.mjs', why: 'a net' }] }))
  const before = readTree(r, E).events.length
  assert.equal(call(r, 'net', '--node', 'c', '--file', file).error.kind, 'not_a_leaf')
  assert.equal(call(r, 'net', '--node', 'c', '--file', join(r, 'nope.json')).error.kind, 'unknown_file')
  assert.equal(call(r, 'net', '--node', 'c', '--file', file, '--execution', OLDER).error.kind, 'bad_arg')
  assert.equal(readTree(r, E).events.length, before, 'nothing written')
})
