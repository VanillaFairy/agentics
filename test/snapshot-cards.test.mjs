// test/snapshot-cards.test.mjs — the viewer's read contract: the cards of snapshotOf: a leaf's next
// action, the commits it is behind, its report, its notes, the relaunch, the live activity and the
// checkout change, and the CLI's one entry, pinned against real git branches, worktrees, specs and
// the ledger.
//
// Every expected value here comes from agentics' own functions (approvalState, todoFor, costOf,
// parseSpec, branchOf, worktreeOf, hashSpec, normalizeNode, deriveStatus via readTree) or from the
// fixture's own text (lineOf) or its own git history (git log / rev-list) - never a literal the
// fixture decides. The fixtures the parts share are in test/harness/snapshot-world.mjs.
//
// Design: agentics-viewer/shared/interfaces.md section Snapshot contract.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { append } from '../lib/ledger.mjs'
import { resumeLeaves } from '../lib/resume.mjs'
import {
  branchOf, dispatchKey, effortStateDir, executionDir, executionRunId, livePath, nodeKey, posix, returnPath,
  runJsonPath, writeJson,
} from '../lib/store.mjs'
import { readTree } from '../lib/tree.mjs'
import { DEAD_PID } from './harness/dead-pid.mjs'
import {
  nodeOf, renderNode, snapshotOf, CLI, git, FIX_REASON, FIX_DETAIL, round, D_IMPL, IMPL_TEXT,
  effortFixture, sharedFixture, statusFixture,
} from './harness/snapshot-world.mjs'

const cardsOf = (repo, effort) => Object.fromEntries(snapshotOf(repo, effort).nodes.map((n) => [n.id, n.card]))

test("a leaf's next action is the resume ladder's", () => {
  const { repo, effort, stamp } = sharedFixture()
  const tree = readTree(repo, effort)
  const rows = Object.fromEntries(resumeLeaves(repo, effort, stamp, tree.nodes).map((r) => [r.id, r]))
  const cards = cardsOf(repo, effort)
  for (const id of ['a/impl', 'a/fix', 'a/wait', 'c']) {
    assert.deepEqual(cards[id].next, { action: rows[id].next_action, why: rows[id].note }, id)
  }
  assert.notEqual(cards['a/impl'].next.action, cards['a/fix'].next.action, 'the fixture has a started leaf and an unstarted one')
})

test('only an unfinished leaf has a next action', () => {
  const { repo, effort } = statusFixture()
  const tree = readTree(repo, effort)
  const cards = cardsOf(repo, effort)
  for (const [id, n] of tree.nodes) {
    const unfinished = n.kind === 'leaf' && tree.status.get(id).status !== 'merged'
    assert.equal(cards[id].next !== null, unfinished, id)
  }
})

test("behind counts the folder's commits a leaf's branch lacks", () => {
  const { repo, effort } = effortFixture()
  assert.equal(cardsOf(repo, effort)['a/impl'].behind, 0)

  const mainBranch = git(repo, 'symbolic-ref', '--short', 'HEAD')
  git(repo, 'checkout', '-q', branchOf(effort, 'a'))
  writeFileSync(join(repo, 'later.txt'), 'later\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'a fix the folder took after the leaf was cut')
  git(repo, 'checkout', '-q', mainBranch)

  const cards = cardsOf(repo, effort)
  assert.equal(cards['a/impl'].behind, Number(git(repo, 'rev-list', '--count', branchOf(effort, 'a/impl') + '..' + branchOf(effort, 'a'))))
  assert.ok(cards['a/impl'].behind > 0)
  assert.equal(cards['a/fix'].behind, null, 'a leaf with no branch is behind nothing')
  assert.equal(cards.a.behind, null, 'a folder is not a leaf')
})

test("the card's report is the latest return that carries text, with its lead", () => {
  const { repo, effort, stamp } = effortFixture()
  const dir = executionDir(repo, effort, stamp)
  // Where 4.x wrote a dispatch's brief, its report and its progress file: none is read, so none is the card's report.
  const stem = nodeKey('a/impl') + '-implementer-r1'
  const reports = join(effortStateDir(repo, effort), 'reports', stamp + '-' + stem)
  const old = [join(dir, 'briefs', stem + '.md'), reports + '.md', reports + '.json']
  for (const path of old) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, path.endsWith('.json') ? JSON.stringify({ items: [{ name: 'Parser', state: 'done' }] }) : 'a 4.x file\n')
  }
  assert.deepEqual(cardsOf(repo, effort)['a/impl'].report, { dispatch: D_IMPL, lead: IMPL_TEXT }, 'the report is the stored return, not a 4.x file')
  const dispatched = (d, n, role) => append(repo, effort, 'events', { kind: 'dispatched', node: 'a/impl', execution: stamp, dispatch: d, role, round: n, model: 'sonnet', effort: 'medium' })
  const second = round('a/impl', 2)
  const lead = ['The suite fails on two tests', 'outside this locus.']
  dispatched(second, 2, 'implementer')
  writeJson(returnPath(dir, second), { status: 'done', text: ['', '# Round 2', '', ...lead, '', 'More.', ''].join('\r\n') })
  const third = round('a/impl', 3)
  dispatched(third, 3, 'implementer')
  writeJson(returnPath(dir, third), { status: 'done', text: '  ' })
  assert.deepEqual(cardsOf(repo, effort)['a/impl'].report, { dispatch: second, lead: lead.join(' ') }, 'a return with no words is passed over')
  assert.ok(renderNode(nodeOf(repo, effort, 'a/impl')).includes('report (' + second + '): ' + lead.join(' ')), 'renderNode prints the dispatch and the lead')

  const review = dispatchKey({ node: 'a/impl', role: 'reviewer', thread: 'reviewer:a/impl:1', round: 1 })
  dispatched(review, 1, 'reviewer')
  writeJson(returnPath(dir, review), { findings: [], units: [], notes: 'Clean: both criteria hold.', stop_reason: 'done', not_reached: [] })
  assert.deepEqual(cardsOf(repo, effort)['a/impl'].report, { dispatch: review, lead: 'Clean: both criteria hold.' }, 'a judge\'s notes are its words')
  assert.equal(cardsOf(repo, effort)['a/fix'].report, null, 'a call that never returned has no report')
  const text = JSON.stringify(snapshotOf(repo, effort))
  for (const path of old) assert.ok(!text.includes(posix(path).split('/').pop()), 'the snapshot names ' + path)
})

test('notes are on the card newest first, and move no status', () => {
  const { repo, effort, stamp } = effortFixture()
  const before = readTree(repo, effort).status
  const texts = ['the base lacks the timeout fix', 'rebased onto the folder branch']
  for (const text of texts) append(repo, effort, 'events', { kind: 'noted', node: 'a/fix', execution: stamp, by: 'session', text })

  const cards = cardsOf(repo, effort)
  assert.deepEqual(cards['a/fix'].notes.map((n) => [n.by, n.text]), [...texts].reverse().map((t) => ['session', t]))
  assert.deepEqual(cards['a/impl'].notes, [])
  const after = readTree(repo, effort).status
  for (const [id, s] of before) assert.equal(after.get(id).status, s.status, id)
})

test('relaunch names the open execution, and retry holds only the node that escalated itself', () => {
  const { repo, effort, stamp } = effortFixture()
  const cards = cardsOf(repo, effort)
  assert.deepEqual(cards['a/fix'].relaunch, { execution: stamp, root: '.', retry: ['a/fix'] })
  assert.deepEqual(cards['a/wait'].relaunch, { execution: stamp, root: '.', retry: [] })
  assert.deepEqual(cards.a.relaunch.retry, [], 'a folder escalated only through a child retries nothing itself')

  append(repo, effort, 'state:' + stamp, { kind: 'closed', status: 'done' })
  assert.equal(cardsOf(repo, effort)['a/fix'].relaunch, null)
})

test('an execution rooted elsewhere does not hold the node', () => {
  const { repo, effort, stamp } = effortFixture()
  writeFileSync(join(executionDir(repo, effort, stamp), 'execution.json'), JSON.stringify({ root: 'a' }))
  const cards = cardsOf(repo, effort)
  assert.equal(cards['a/fix'].relaunch.root, 'a')
  assert.equal(cards.a.relaunch.root, 'a')
  assert.equal(cards.c.relaunch, null)
})

test('node prints one entry of the snapshot, for a person or as JSON', () => {
  const { repo, effort, stamp } = effortFixture()
  append(repo, effort, 'events', { kind: 'noted', node: 'a/fix', execution: stamp, by: 'session', text: 'a note' })
  const entry = snapshotOf(repo, effort).nodes.find((n) => n.id === 'a/fix')
  assert.deepEqual(nodeOf(repo, effort, 'a/fix'), entry)

  const run = (...args) => spawnSync(process.execPath, [CLI, 'node', '--repo', repo, '--effort', effort, ...args], { encoding: 'utf8' })
  const json = run('--node', 'a/fix', '--json')
  assert.equal(json.status, 0, json.stdout + json.stderr)
  assert.deepEqual(JSON.parse(json.stdout).payload, entry)

  const text = run('--node', 'a/fix')
  assert.equal(text.stdout.trim(), renderNode(entry))
  for (const said of [FIX_REASON, FIX_DETAIL, entry.card.next.action, 'a note', stamp, JSON.stringify(['a/fix'])]) {
    assert.ok(text.stdout.includes(said), 'the rendering leaves out ' + said)
  }

  const missing = run('--node', 'nope')
  assert.equal(missing.status, 1)
  assert.match(JSON.parse(missing.stdout).error, /no live node/)
})

test('live is the running dispatch\'s activity while its execution\'s run is live, and null otherwise', () => {
  const { repo, effort, stamp } = effortFixture()
  const dir = executionDir(repo, effort, stamp)
  const running = round('a/impl', 2)
  append(repo, effort, 'events', { kind: 'dispatched', node: 'a/impl', execution: stamp, dispatch: running, role: 'implementer', round: 2, model: 'sonnet', effort: 'medium' })
  const activity = { turns: 7, tool: { name: 'Edit', target: 'src/a-impl.js' }, at: '2026-09-27T10:00:00.000Z' }
  writeJson(livePath(dir, running), activity)
  writeJson(livePath(dir, D_IMPL), { turns: 1, tool: { name: 'Read', target: '' }, at: '2026-09-27T09:00:00.000Z' })
  assert.equal(nodeOf(repo, effort, 'a/impl').live, null, 'no run holds the execution')

  const run = executionRunId(effort, stamp)
  const meta = (pid) => writeJson(runJsonPath(repo, run), { run, pid, heartbeat_at: new Date().toISOString() })
  meta(process.pid)
  const expected = { dispatch: running, ...activity }
  assert.deepEqual(nodeOf(repo, effort, 'a/impl').live, expected, 'the latest dispatch\'s activity, never an earlier one\'s')
  const byId = Object.fromEntries(snapshotOf(repo, effort).nodes.map((n) => [n.id, n]))
  assert.deepEqual(byId['a/impl'].live, expected)
  assert.equal(byId['a/fix'].live, null, 'a dispatch with no live file')
  assert.equal(byId['a/wait'].live, null, 'a node never dispatched')
  assert.match(renderNode(byId['a/impl']), /^live: .*7 turn\(s\), last Edit src\/a-impl\.js/m)
  assert.match(renderNode({ ...byId['a/impl'], live: { ...expected, tool: { name: 'Read', target: '' } } }), /^live: .*, last Read at /m)

  meta(DEAD_PID)
  assert.equal(nodeOf(repo, effort, 'a/impl').live, null, 'a run whose process is gone')
})

test('a node\'s card shows the latest checkout change of its own dispatches', () => {
  const { repo, effort, stamp } = effortFixture()
  append(repo, effort, 'state:' + stamp, { kind: 'checkout_changed', dispatch: D_IMPL, paths: ['notes.md'] })
  append(repo, effort, 'state:' + stamp, { kind: 'checkout_changed', dispatch: D_IMPL, paths: ['README.md', 'notes.md'] })
  const byId = Object.fromEntries(snapshotOf(repo, effort).nodes.map((n) => [n.id, n]))
  assert.deepEqual(byId['a/impl'].card.checkout_changed, { dispatch: D_IMPL, paths: ['README.md', 'notes.md'] })
  assert.equal(byId['a/fix'].card.checkout_changed, null)
  assert.ok(renderNode(byId['a/impl']).includes('checkout changed by ' + D_IMPL + ': README.md, notes.md'))
})
