// test/snapshot-payload.test.mjs — the viewer's read contract: snapshotOf's payload (the store, the
// nodes, the events, the status, the commits, the spec links, the returns, the counts, the cost)
// and the CLI that prints it, pinned against real git branches, worktrees, specs and the ledger.
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
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { approvalState } from '../lib/approval.mjs'
import { append } from '../lib/ledger.mjs'
import { canonical, fnv1a } from '../lib/plan-digest.mjs'
import { parseSpec } from '../lib/spec.mjs'
import { costOf, efforts, todoFor } from '../lib/status.mjs'
import {
  agenticsRoot, branchOf, executionDir, parentOf, posix, returnPath, specPath, worktreeOf,
} from '../lib/store.mjs'
import { normalizeNode, readTree, renderTree } from '../lib/tree.mjs'
import {
  snapshotOf, CLI, git, leaf, composite, FIX_REASON, FIX_DETAIL, WAIT_RETURN, WAIT_QUESTION, D_IMPL,
  ROOT_SPEC, A_SPEC, RAW_NODES, effortFixture, sharedFixture, statusFixture,
} from './harness/snapshot-world.mjs'

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

function linkedWorktree(repo) {
  const wt = posix(join(mkdtempSync(join(tmpdir(), 'agentics-snapshot-wt-')), 'wt'))
  git(repo, 'worktree', 'add', '-q', '-b', 'side', wt)
  return wt
}

test('snapshot carries format 4', () => {
  const { repo, effort } = sharedFixture()
  assert.equal(snapshotOf(repo, effort).format, 4)
})

test("store names the main checkout's .agentics", () => {
  const { repo, effort } = sharedFixture()
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
  const { repo, effort } = sharedFixture()
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

test("event carries its kind's payload fields", () => {
  const { repo, effort } = sharedFixture()
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
  const { repo, effort } = sharedFixture()
  const tree = readTree(repo, effort)
  const byId = Object.fromEntries(snapshotOf(repo, effort).nodes.map((n) => [n.id, n]))
  for (const id of tree.nodes.keys()) {
    const todo = todoFor(tree.nodes, tree.status, tree.events, id)
    if (todo.status === 'in_progress') assert.equal(byId[id].stage, todo.activeForm, id)
    else assert.equal(byId[id].stage, null, id)
  }
})

test('every reachable status passes through unchanged', () => {
  const { repo, effort } = statusFixture()
  const tree = readTree(repo, effort)
  const ids = [...tree.nodes.keys()]
  const reached = new Set(ids.map((id) => tree.status.get(id).status))
  for (const s of ['planned', 'active', 'approved', 'merged', 'reviewing', 'integrated', 'parked', 'escalated', 'open']) {
    assert.ok(reached.has(s), 'the fixture never reaches status ' + s)
  }
  const byId = Object.fromEntries(snapshotOf(repo, effort).nodes.map((n) => [n.id, n]))
  for (const id of ids) assert.equal(byId[id].status, tree.status.get(id).status, id)
})

test('a folder whose children merged has its integration review as an entry of its own, after its children', () => {
  const { repo, effort } = statusFixture()
  const nodes = snapshotOf(repo, effort).nodes
  const at = (id) => nodes.findIndex((n) => n.id === id)
  const due = nodes[at('merged-folder/@review')]
  assert.deepEqual([due.parent, due.kind, due.status, due.stage], ['merged-folder', 'review', 'pending', 'in review'])
  assert.ok(at('merged-folder/@review') > at('merged-folder/y'), 'the review comes after the children it reviews')
  assert.equal(nodes[at('merged-folder')].status, 'reviewing')
  const done = nodes[at('reviewed-folder/@review')]
  assert.deepEqual([done.status, done.stage], ['not_earned', null])
  assert.equal(nodes[at('reviewed-folder')].status, 'integrated')
  assert.equal(at('@review'), -1, 'a root whose children have not all merged has no review entry')
})

test('commits count from the parent integration branch', () => {
  const { repo, effort } = sharedFixture()
  const impl = snapshotOf(repo, effort).nodes.find((n) => n.id === 'a/impl')
  const expectedCount = Number(git(repo, 'rev-list', '--count', branchOf(effort, 'a') + '..' + branchOf(effort, 'a/impl')))
  const expectedSubject = git(repo, 'log', '-1', '--format=%s', branchOf(effort, 'a/impl'))
  const expectedAt = git(repo, 'log', '-1', '--format=%cI', branchOf(effort, 'a/impl'))
  assert.equal(impl.commits.count, expectedCount)
  assert.equal(impl.commits.last_subject, expectedSubject)
  assert.equal(new Date(impl.commits.last_at).getTime(), new Date(expectedAt).getTime())
})

test('commits only for active leaves', () => {
  const { repo, effort } = sharedFixture()
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
  const { repo, effort } = sharedFixture()
  const byId = Object.fromEntries(snapshotOf(repo, effort).nodes.map((n) => [n.id, n]))
  assert.ok(samePath(repo, byId['a/impl'].worktree, worktreeOf(repo, effort, 'a/impl')))
  assert.equal(byId['a/fix'].worktree, null)
})

test('a folder links its own spec', () => {
  const { repo, effort } = sharedFixture()
  const a = snapshotOf(repo, effort).nodes.find((n) => n.id === 'a')
  assert.equal(a.files.spec.line, null)
  assert.ok(samePath(repo, a.files.spec.path, specPath(repo, effort, 'a')))
})

test('a task links its parent spec at its entry line', () => {
  const { repo, effort } = sharedFixture()
  const impl = snapshotOf(repo, effort).nodes.find((n) => n.id === 'a/impl')
  assert.ok(samePath(repo, impl.files.spec.path, specPath(repo, effort, 'a')))
  assert.equal(impl.files.spec.line, lineOf(A_SPEC, '- **impl**'))
})

test('files.returns lists the node\'s stored returns on disk', () => {
  const { repo, effort, stamp } = sharedFixture()
  const byId = Object.fromEntries(snapshotOf(repo, effort).nodes.map((n) => [n.id, n]))
  const impl = byId['a/impl'].files.returns
  assert.equal(impl.length, 1)
  assert.ok(samePath(repo, impl[0], returnPath(executionDir(repo, effort, stamp), D_IMPL)))
  assert.deepEqual(byId['a/fix'].files.returns, [], 'a call that never returned stored nothing')
})

test('a dispatch made again names its stored return once', () => {
  const { repo, effort, stamp } = effortFixture()
  append(repo, effort, 'events', { kind: 'dispatched', node: 'a/impl', execution: stamp, dispatch: D_IMPL, role: 'implementer', round: 1, model: 'sonnet', effort: 'medium' })
  const again = snapshotOf(repo, effort).nodes.find((n) => n.id === 'a/impl').files.returns
  assert.equal(again.length, 1, 'a dispatch made again names its return once')
})

test('folders carry approval and blocking counts', () => {
  const { repo, effort } = sharedFixture()
  const byId = Object.fromEntries(snapshotOf(repo, effort).folders.map((f) => [f.id, f]))
  assert.deepEqual(Object.keys(byId).sort(), ['.', 'a'])

  assert.equal(byId['.'].approval, approvalState(repo, effort, '.').state)
  assert.equal(byId.a.approval, approvalState(repo, effort, 'a').state)

  const blockingCount = (text) => parseSpec(text).questions.filter((q) => q.grade === 'blocking').length
  assert.equal(byId['.'].blocking, blockingCount(ROOT_SPEC))
  assert.equal(byId.a.blocking, blockingCount(A_SPEC))
})

test('cost matches costOf', () => {
  const { repo, effort } = sharedFixture()
  const snap = snapshotOf(repo, effort)
  const c = costOf(repo, effort)
  const FIELDS = ['dispatches', 'tokens', 'usd', 'unmeasured']
  assert.ok(c.tokens > 0 && c.unmeasured > 0, 'the fixture has both a measured call and one that never returned')
  for (const field of FIELDS) assert.equal(snap.cost[field], c[field], field)
  for (const group of ['by_model', 'per_leaf', 'per_folder']) {
    assert.deepEqual(Object.keys(snap.cost[group]).sort(), Object.keys(c[group]).sort(), group)
    for (const [key, s] of Object.entries(c[group])) for (const field of FIELDS) assert.equal(snap.cost[group][key][field], s[field], group + ' ' + key + ' ' + field)
  }
})

test('node fields pass through', () => {
  const { repo, effort } = sharedFixture()
  const normalized = normalizeNode(RAW_NODES.find((n) => n.id === 'a/fix'))
  const n = snapshotOf(repo, effort).nodes.find((x) => x.id === 'a/fix')
  assert.deepEqual(n.deps, normalized.deps)
  assert.deepEqual(n.acceptance, normalized.acceptance)
  assert.deepEqual(n.expects, normalized.expects)
  assert.equal(n.rigor, normalized.rigor)
  assert.equal(n.role, normalized.role)
})

test('snapshot writes nothing', () => {
  const { repo, effort } = sharedFixture()
  const before = filesUnder(agenticsRoot(repo))

  snapshotOf(repo, effort)
  assert.ok(sameBytes(before, filesUnder(agenticsRoot(repo))), 'snapshotOf must not write')

  const r = spawnSync(process.execPath, [CLI, 'snapshot', '--repo', repo, '--effort', effort, '--json'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.ok(sameBytes(before, filesUnder(agenticsRoot(repo))), 'the CLI must not write either')
})

test('CLI prints the envelope', () => {
  const { repo, effort } = sharedFixture()
  const r = spawnSync(process.execPath, [CLI, 'snapshot', '--repo', repo, '--effort', effort, '--json'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.payload_digest, fnv1a(canonical(out.payload)))
  assert.deepEqual(out.payload, snapshotOf(repo, effort))
})

test('CLI prints the tree for a person', () => {
  const { repo, effort } = sharedFixture()
  const r = spawnSync(process.execPath, [CLI, 'snapshot', '--repo', repo, '--effort', effort], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const tree = readTree(repo, effort)
  assert.equal(r.stdout.trim(), renderTree(tree.nodes, tree.status).trim())
})
