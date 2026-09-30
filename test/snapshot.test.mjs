// test/snapshot.test.mjs — the viewer's read contract: snapshotOf's payload and the CLI that
// prints it, pinned against real git branches, worktrees, specs and the ledger.
//
// Every expected value here comes from agentics' own functions (approvalState, todoFor, costOf,
// parseSpec, branchOf, worktreeOf, hashSpec, normalizeNode, deriveStatus via readTree) or from the
// fixture's own text (lineOf) or its own git history (git log / rev-list) - never a literal the
// fixture decides.
//
// Design: agentics-viewer/shared/interfaces.md section Snapshot contract.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { approvalState } from '../lib/approval.mjs'
import { append } from '../lib/ledger.mjs'
import { canonical, fnv1a } from '../lib/plan-digest.mjs'
import { resumeLeaves } from '../lib/resume.mjs'
import { hashSpec, parseSpec } from '../lib/spec.mjs'
import { costOf, efforts, todoFor } from '../lib/status.mjs'
import * as statusModule from '../lib/status.mjs'
import {
  agenticsRoot, branchOf, briefPath, executionDir, parentOf, posix, reportPath, specPath, worktreeOf,
} from '../lib/store.mjs'
import { normalizeNode, readTree, renderTree } from '../lib/tree.mjs'

const { nodeOf, renderNode, snapshotOf } = statusModule

const CLI = fileURLToPath(new URL('../lib/status.mjs', import.meta.url))

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

function lineOf(text, needle, from = 1) {
  const lines = text.split('\n')
  for (let i = from - 1; i < lines.length; i++) if (lines[i].includes(needle)) return i + 1
  throw new Error('no line contains ' + JSON.stringify(needle))
}

const samePath = (base, a, b) => posix(resolve(base, String(a))) === posix(resolve(base, String(b)))

function filesUnder(root) {
  const out = new Map()
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else out.set(posix(relative(root, p)), readFileSync(p))
    }
  }
  walk(root)
  return out
}
const sameBytes = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.has(k) && b.get(k).equals(v))

const leaf = (id, extra = {}) => ({
  id, title: 'do ' + id, kind: 'leaf', rigor: 'trivial', locus: ['src/' + id.split('/').join('-') + '.js'],
  acceptance: [{ text: id + ' works', check: 'true' }], deps: [], ...extra,
})
const composite = (id, extra = {}) => ({ id, title: 'folder ' + id, kind: 'composite', deps: [], ...extra })
const design = (id, extra = {}) => ({ id, title: 'design ' + id, kind: 'design', author: 'you', deps: [], ...extra })

const EFFORT = 'eff'
const STAMP = '20260927-100000'
const FIX_REASON = 'verify_oscillating'
const FIX_DETAIL = 'the fix diverged twice'
const WAIT_RETURN = 'needs_decision'
const WAIT_QUESTION = 'what does the wait step wait for?'

const ROOT_SPEC = [
  '# Eff root', '',
  '## Intent', '',
  'Ship the eff.', '',
  '## Decisions', '',
  '| id | decision | why |',
  '|---|---|---|',
  '| D1 | a happens | needed |',
  '| D2 | c happens | needed |',
  '',
  '## Design', '',
  'As planned.', '',
  '## Plan', '',
  '- **a** — sub-effort · realises: D1',
  '  Build a.',
  '- **c** — task · realises: D2 · rigor: trivial · locus: src/c.js',
  '  Do c.',
  '  - [ ] c works — check: `true`',
  '',
  '## Open questions', '',
  '## Evidence', '',
  'None yet.', '',
].join('\n')

const A_SPEC = [
  '# A', '',
  '## Intent', '',
  'Build a.', '',
  '## Decisions', '',
  '| id | decision | why |',
  '|---|---|---|',
  '| a.D1 | impl happens | needed |',
  '| a.D2 | fix happens | needed |',
  '| a.D3 | wait happens | needed |',
  '',
  '## Design', '',
  'As planned.', '',
  '## Plan', '',
  '- **impl** — task · realises: a.D1 · rigor: trivial · locus: src/impl.js',
  '  Implement it.',
  '  - [ ] impl works — check: `true`',
  '- **fix** — task · realises: a.D2 · rigor: trivial · locus: src/fix.js · after: impl',
  '  Fix it.',
  '  - [ ] fix works — check: `true`',
  '- **wait** — task · realises: a.D3 · rigor: trivial · locus: src/wait.js',
  '  Wait for it.',
  '  - [ ] wait works — check: `true`',
  '',
  '## Open questions', '',
  '- **blocking:** ' + WAIT_QUESTION,
  '',
  '## Evidence', '',
  'None yet.', '',
].join('\n')

const RAW_NODES = [
  composite('.'),
  composite('a'),
  leaf('a/impl'),
  leaf('a/fix', { deps: ['a/impl'] }),
  leaf('a/wait'),
  leaf('c'),
]

function writeSpec(repo, effort, folderId, text) {
  const p = specPath(repo, effort, folderId)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, text)
}

function effortFixture() {
  const repo = posix(mkdtempSync(join(tmpdir(), 'agentics-snapshot-')))
  git(repo, 'init', '-q', '.')
  git(repo, 'config', 'user.email', 't@t')
  git(repo, 'config', 'user.name', 't')
  git(repo, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(repo, 'README.md'), 'root\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'init')
  const mainBranch = git(repo, 'symbolic-ref', '--short', 'HEAD')

  writeSpec(repo, EFFORT, '.', ROOT_SPEC)
  writeSpec(repo, EFFORT, 'a', A_SPEC)
  append(repo, EFFORT, 'ledger', { kind: 'approved', folder: '.', hash: hashSpec(ROOT_SPEC), decisions: [], by: 'user' })

  append(repo, EFFORT, 'nodes', RAW_NODES.map((node) => ({ kind: 'node', node })))

  const ev = (kind, node, extra = {}) => append(repo, EFFORT, 'events', { kind, node, execution: STAMP, ...extra })
  ev('dispatched', 'a/impl', { role: 'implementer', round: 1, model: 'sonnet', effort: 'medium' })
  ev('dispatched', 'a/fix', { role: 'implementer', round: 1, model: 'sonnet', effort: 'medium' })
  ev('escalated', 'a/fix', { reason: FIX_REASON, detail: FIX_DETAIL })
  ev('parked', 'a/wait', { return: WAIT_RETURN, question: WAIT_QUESTION })

  git(repo, 'branch', branchOf(EFFORT, 'a'))
  git(repo, 'checkout', '-q', branchOf(EFFORT, 'a'))
  writeFileSync(join(repo, 'a-integration.txt'), 'integration\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'a folder integration commit')
  git(repo, 'checkout', '-q', mainBranch)

  git(repo, 'branch', branchOf(EFFORT, 'a/impl'), branchOf(EFFORT, 'a'))
  const wt = worktreeOf(repo, EFFORT, 'a/impl')
  mkdirSync(dirname(wt), { recursive: true })
  git(repo, 'worktree', 'add', '-q', wt, branchOf(EFFORT, 'a/impl'))
  writeFileSync(join(wt, 'note.txt'), 'first\n')
  git(wt, 'add', '-A')
  git(wt, 'commit', '-qm', 'a/impl: first change')
  writeFileSync(join(wt, 'note.txt'), 'second\n')
  git(wt, 'add', '-A')
  git(wt, 'commit', '-qm', 'a/impl: second change')

  mkdirSync(executionDir(repo, EFFORT, STAMP), { recursive: true })
  writeFileSync(join(executionDir(repo, EFFORT, STAMP), 'execution.json'), JSON.stringify({ root: '.' }))
  const brief = briefPath(repo, EFFORT, STAMP, 'a/impl', 'implementer', 1)
  mkdirSync(dirname(brief), { recursive: true })
  writeFileSync(brief, 'brief for a/impl\n')
  const report = reportPath(repo, EFFORT, STAMP, 'a/impl', 'implementer', 1)
  mkdirSync(dirname(report), { recursive: true })
  writeFileSync(report, 'report for a/impl\n')

  append(repo, EFFORT, 'state:' + STAMP, [
    { kind: 'dispatch', label: 'implementer:a/impl#1', node: 'a/impl', role: 'implementer', model: 'sonnet', effort: 'medium' },
    { kind: 'dispatch', label: 'implementer:a/fix#1', node: 'a/fix', role: 'implementer', model: 'sonnet', effort: 'medium' },
    { kind: 'usage', agent: 'a1', label: 'implementer:a/impl#1', models: { 'claude-sonnet-5': { input: 100, cache_write_5m: 40, cache_write_1h: 0, cache_read: 1000, output: 60 } } },
  ])

  return { repo, effort: EFFORT, stamp: STAMP }
}

function linkedWorktree(repo) {
  const wt = posix(join(mkdtempSync(join(tmpdir(), 'agentics-snapshot-wt-')), 'wt'))
  git(repo, 'worktree', 'add', '-q', '-b', 'side', wt)
  return wt
}

test('snapshot carries format 3', () => {
  const { repo, effort } = effortFixture()
  assert.equal(snapshotOf(repo, effort).format, 3)
})

test("store names the main checkout's .agentics", () => {
  const { repo, effort } = effortFixture()
  assert.equal(snapshotOf(repo, effort).store, posix(agenticsRoot(repo)))
})

test("a snapshot taken from a linked worktree reads the main checkout's store", () => {
  const { repo, effort } = effortFixture()
  const wt = linkedWorktree(repo)
  assert.deepEqual(snapshotOf(wt, effort), snapshotOf(repo, effort))
})

test('list carries store', () => {
  const repo = posix(mkdtempSync(join(tmpdir(), 'agentics-snapshot-list-')))
  append(repo, 'e1', 'nodes', [{ kind: 'node', node: composite('.') }])
  const out = efforts(repo)
  assert.equal(out.store_present, true)
  assert.equal(out.store, posix(agenticsRoot(repo)))
})

test('list carries store with no store present', () => {
  const repo = posix(mkdtempSync(join(tmpdir(), 'agentics-snapshot-nostore-')))
  const out = efforts(repo)
  assert.equal(out.store_present, false)
  assert.equal(out.store, posix(agenticsRoot(repo)))
})

test('every live node appears once with its parent', () => {
  const { repo, effort } = effortFixture()
  const tree = readTree(repo, effort)
  const snap = snapshotOf(repo, effort)
  assert.equal(snap.nodes.length, tree.nodes.size)
  const seen = new Set()
  for (const n of snap.nodes) {
    assert.ok(!seen.has(n.id), 'duplicate ' + n.id)
    seen.add(n.id)
    assert.equal(n.parent, parentOf(n.id), n.id)
  }
  assert.deepEqual([...seen].sort(), [...tree.nodes.keys()].sort())
})

test('status passes through from deriveStatus', () => {
  const { repo, effort } = effortFixture()
  const tree = readTree(repo, effort)
  const byId = Object.fromEntries(snapshotOf(repo, effort).nodes.map((n) => [n.id, n]))
  for (const id of tree.nodes.keys()) assert.equal(byId[id].status, tree.status.get(id).status, id)
})

test("event carries its kind's payload fields", () => {
  const { repo, effort } = effortFixture()
  const byId = Object.fromEntries(snapshotOf(repo, effort).nodes.map((n) => [n.id, n]))

  const fix = byId['a/fix'].event
  assert.equal(fix.kind, 'escalated')
  assert.equal(typeof fix.seq, 'number')
  assert.equal(fix.reason, FIX_REASON)
  assert.equal(fix.detail, FIX_DETAIL)

  const wait = byId['a/wait'].event
  assert.equal(wait.kind, 'parked')
  assert.equal(typeof wait.seq, 'number')
  assert.equal(wait.return, WAIT_RETURN)
  assert.equal(wait.question, WAIT_QUESTION)
})

test("stage is todoFor's activeForm only while in progress", () => {
  const { repo, effort } = effortFixture()
  const tree = readTree(repo, effort)
  const byId = Object.fromEntries(snapshotOf(repo, effort).nodes.map((n) => [n.id, n]))
  for (const id of tree.nodes.keys()) {
    const todo = todoFor(tree.nodes, tree.status, tree.events, id)
    if (todo.status === 'in_progress') assert.equal(byId[id].stage, todo.activeForm, id)
    else assert.equal(byId[id].stage, null, id)
  }
})

function statusFixture() {
  const repo = posix(mkdtempSync(join(tmpdir(), 'agentics-snapshot-status-')))
  const effort = 'st'
  const nodes = [
    composite('.'),
    leaf('planned-leaf'),
    leaf('active-leaf'),
    leaf('approved-leaf'),
    leaf('merged-leaf'),
    composite('merged-folder'),
    leaf('merged-folder/x'),
    leaf('merged-folder/y'),
    leaf('parked-leaf'),
    leaf('escalated-leaf'),
    design('design-node'),
  ]
  append(repo, effort, 'nodes', nodes.map((node) => ({ kind: 'node', node })))
  const ev = (kind, node, extra = {}) => append(repo, effort, 'events', { kind, node, execution: 'x', ...extra })
  ev('dispatched', 'active-leaf', { role: 'implementer', round: 1, model: 'sonnet', effort: 'medium' })
  ev('dispatched', 'approved-leaf', { role: 'implementer', round: 1, model: 'sonnet', effort: 'medium' })
  ev('approved', 'approved-leaf', { head_sha: 'a1' })
  ev('merged', 'merged-leaf', { into: 'agentics/st', merged_sha: 'm', head_sha: 'h' })
  ev('merged', 'merged-folder/x', { into: 'agentics/st--merged-folder', merged_sha: 'm', head_sha: 'h' })
  ev('merged', 'merged-folder/y', { into: 'agentics/st--merged-folder', merged_sha: 'm', head_sha: 'h' })
  ev('parked', 'parked-leaf', { return: 'needs_decision', question: 'q' })
  ev('escalated', 'escalated-leaf', { reason: 'r', detail: 'd' })
  return { repo, effort }
}

test('an open design node passes through', () => {
  const { repo, effort } = statusFixture()
  const tree = readTree(repo, effort)
  const n = snapshotOf(repo, effort).nodes.find((x) => x.id === 'design-node')
  assert.equal(n.status, tree.status.get('design-node').status)
  assert.equal(n.stage, null)
})

test('an integrated folder passes through', () => {
  const { repo, effort } = statusFixture()
  const tree = readTree(repo, effort)
  const n = snapshotOf(repo, effort).nodes.find((x) => x.id === 'merged-folder')
  assert.equal(n.status, tree.status.get('merged-folder').status)
})

test('every reachable status passes through unchanged', () => {
  const { repo, effort } = statusFixture()
  const tree = readTree(repo, effort)
  const ids = [...tree.nodes.keys()]
  const reached = new Set(ids.map((id) => tree.status.get(id).status))
  for (const s of ['planned', 'active', 'approved', 'merged', 'integrated', 'parked', 'escalated', 'open']) {
    assert.ok(reached.has(s), 'the fixture never reaches status ' + s)
  }
  const byId = Object.fromEntries(snapshotOf(repo, effort).nodes.map((n) => [n.id, n]))
  for (const id of ids) assert.equal(byId[id].status, tree.status.get(id).status, id)
})

test('commits count from the parent integration branch', () => {
  const { repo, effort } = effortFixture()
  const impl = snapshotOf(repo, effort).nodes.find((n) => n.id === 'a/impl')
  const expectedCount = Number(git(repo, 'rev-list', '--count', branchOf(effort, 'a') + '..' + branchOf(effort, 'a/impl')))
  const expectedSubject = git(repo, 'log', '-1', '--format=%s', branchOf(effort, 'a/impl'))
  const expectedAt = git(repo, 'log', '-1', '--format=%cI', branchOf(effort, 'a/impl'))
  assert.equal(impl.commits.count, expectedCount)
  assert.equal(impl.commits.last_subject, expectedSubject)
  assert.equal(new Date(impl.commits.last_at).getTime(), new Date(expectedAt).getTime())
})

test('commits only for active leaves', () => {
  const { repo, effort } = effortFixture()
  const snap = snapshotOf(repo, effort)
  for (const n of snap.nodes) if (n.id !== 'a/impl') assert.equal(n.commits, null, n.id)
})

test('commits null when a branch is missing', () => {
  const repo = posix(mkdtempSync(join(tmpdir(), 'agentics-snapshot-nobranch-')))
  const effort = 'nb'
  append(repo, effort, 'nodes', [composite('.'), leaf('solo')].map((node) => ({ kind: 'node', node })))
  append(repo, effort, 'events', { kind: 'dispatched', node: 'solo', execution: 'x', role: 'implementer', round: 1, model: 'sonnet', effort: 'medium' })
  const n = snapshotOf(repo, effort).nodes.find((x) => x.id === 'solo')
  assert.equal(n.commits, null)
})

test('worktree only when it exists', () => {
  const { repo, effort } = effortFixture()
  const byId = Object.fromEntries(snapshotOf(repo, effort).nodes.map((n) => [n.id, n]))
  assert.ok(samePath(repo, byId['a/impl'].worktree, worktreeOf(repo, effort, 'a/impl')))
  assert.equal(byId['a/fix'].worktree, null)
})

test('a folder links its own spec', () => {
  const { repo, effort } = effortFixture()
  const a = snapshotOf(repo, effort).nodes.find((n) => n.id === 'a')
  assert.equal(a.files.spec.line, null)
  assert.ok(samePath(repo, a.files.spec.path, specPath(repo, effort, 'a')))
})

test('a task links its parent spec at its entry line', () => {
  const { repo, effort } = effortFixture()
  const impl = snapshotOf(repo, effort).nodes.find((n) => n.id === 'a/impl')
  assert.ok(samePath(repo, impl.files.spec.path, specPath(repo, effort, 'a')))
  assert.equal(impl.files.spec.line, lineOf(A_SPEC, '- **impl**'))
})

test('briefs and reports list only files that exist', () => {
  const { repo, effort, stamp } = effortFixture()
  const byId = Object.fromEntries(snapshotOf(repo, effort).nodes.map((n) => [n.id, n]))

  const impl = byId['a/impl']
  assert.equal(impl.files.briefs.length, 1)
  assert.ok(samePath(repo, impl.files.briefs[0], briefPath(repo, effort, stamp, 'a/impl', 'implementer', 1)))
  assert.equal(impl.files.reports.length, 1)
  assert.ok(samePath(repo, impl.files.reports[0], reportPath(repo, effort, stamp, 'a/impl', 'implementer', 1)))

  const fix = byId['a/fix']
  assert.deepEqual(fix.files.briefs, [])
  assert.deepEqual(fix.files.reports, [])
})

test('folders carry approval and blocking counts', () => {
  const { repo, effort } = effortFixture()
  const byId = Object.fromEntries(snapshotOf(repo, effort).folders.map((f) => [f.id, f]))
  assert.deepEqual(Object.keys(byId).sort(), ['.', 'a'])

  assert.equal(byId['.'].approval, approvalState(repo, effort, '.').state)
  assert.equal(byId.a.approval, approvalState(repo, effort, 'a').state)

  const blockingCount = (text) => parseSpec(text).questions.filter((q) => q.grade === 'blocking').length
  assert.equal(byId['.'].blocking, blockingCount(ROOT_SPEC))
  assert.equal(byId.a.blocking, blockingCount(A_SPEC))
})

test('cost matches costOf', () => {
  const { repo, effort } = effortFixture()
  const snap = snapshotOf(repo, effort)
  const c = costOf(repo, effort)
  assert.equal(snap.cost.dispatches, c.dispatches)
  assert.ok(c.tokens > 0 && c.tokens_unreported > 0, 'the fixture has both a measured and an unreported dispatch')
  for (const field of ['tokens', 'usd', 'tokens_unreported', 'usage']) assert.deepEqual(snap.cost[field], c[field], field)
  for (const [id, leafCost] of Object.entries(c.per_leaf)) {
    assert.equal(snap.cost.per_leaf[id].dispatches, leafCost.dispatches, id)
    for (const field of ['tokens', 'usd', 'tokens_unreported', 'usage']) assert.deepEqual(snap.cost.per_leaf[id][field], leafCost[field], id + ' ' + field)
  }
})

test('node fields pass through', () => {
  const { repo, effort } = effortFixture()
  const normalized = normalizeNode(RAW_NODES.find((n) => n.id === 'a/fix'))
  const n = snapshotOf(repo, effort).nodes.find((x) => x.id === 'a/fix')
  assert.deepEqual(n.deps, normalized.deps)
  assert.deepEqual(n.acceptance, normalized.acceptance)
  assert.deepEqual(n.locus, normalized.locus)
  assert.equal(n.rigor, normalized.rigor)
  assert.equal(n.role, normalized.role)
})

test('snapshot writes nothing', () => {
  const { repo, effort } = effortFixture()
  const before = filesUnder(agenticsRoot(repo))

  snapshotOf(repo, effort)
  assert.ok(sameBytes(before, filesUnder(agenticsRoot(repo))), 'snapshotOf must not write')

  const r = spawnSync(process.execPath, [CLI, 'snapshot', '--repo', repo, '--effort', effort, '--json'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.ok(sameBytes(before, filesUnder(agenticsRoot(repo))), 'the CLI must not write either')
})

test('CLI prints the envelope', () => {
  const { repo, effort } = effortFixture()
  const r = spawnSync(process.execPath, [CLI, 'snapshot', '--repo', repo, '--effort', effort, '--json'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.payload_digest, fnv1a(canonical(out.payload)))
  assert.deepEqual(out.payload, snapshotOf(repo, effort))
})

test('CLI prints the tree for a person', () => {
  const { repo, effort } = effortFixture()
  const r = spawnSync(process.execPath, [CLI, 'snapshot', '--repo', repo, '--effort', effort], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const tree = readTree(repo, effort)
  assert.equal(r.stdout.trim(), renderTree(tree.nodes, tree.status).trim())
})

const cardsOf = (repo, effort) => Object.fromEntries(snapshotOf(repo, effort).nodes.map((n) => [n.id, n.card]))

test("a leaf's next action is the resume ladder's", () => {
  const { repo, effort, stamp } = effortFixture()
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

test("the card's report is the latest dispatch's, with its lead", () => {
  const { repo, effort, stamp } = effortFixture()
  append(repo, effort, 'events', { kind: 'dispatched', node: 'a/impl', execution: stamp, role: 'implementer', round: 2, model: 'sonnet', effort: 'medium' })
  const second = reportPath(repo, effort, stamp, 'a/impl', 'implementer', 2)
  const lead = ['The suite fails on two tests', 'outside this locus.']
  writeFileSync(second, ['', '# Round 2', '', ...lead, '', 'More.', ''].join('\r\n'))

  const cards = cardsOf(repo, effort)
  assert.ok(samePath(repo, cards['a/impl'].report.path, second))
  assert.equal(cards['a/impl'].report.lead, lead.join(' '))
  assert.equal(cards['a/fix'].report, null)
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

test('relaunch names the open execution, and retries only the node that escalated itself', () => {
  const { repo, effort, stamp } = effortFixture()
  const cards = cardsOf(repo, effort)
  assert.deepEqual(cards['a/fix'].relaunch, { execution: stamp, root: '.', retry_escalated: ['a/fix'] })
  assert.deepEqual(cards['a/wait'].relaunch, { execution: stamp, root: '.', retry_escalated: [] })
  assert.deepEqual(cards.a.relaunch.retry_escalated, [], 'a folder escalated only through a child retries nothing itself')

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
