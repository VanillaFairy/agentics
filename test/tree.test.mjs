import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { append } from '../lib/ledger.mjs'
import {
  addNodes, cycleOf, deriveStatus, executorRole, liveNodes, normalizeNode, ownReview, readTree,
  renderTree, subtreeOf, treeProblems,
} from '../lib/tree.mjs'
import { checkAtomicity, coupledOf, fitOf } from '../lib/atomicity.mjs'
import { trace } from '../lib/traceability.mjs'
import { ancestorsOf, branchOf, flat, nodeIdProblem, parentOf, safeSlug, worktreeOf } from '../lib/store.mjs'

const repo = () => mkdtempSync(join(tmpdir(), 'agentics-tree-'))

const leaf = (id, extra = {}) => ({
  id, kind: 'leaf', title: 'do ' + id, rigor: 'tdd', locus: ['src/' + flat(id) + '.js'],
  decisions: ['D1'], acceptance: [{ text: id + ' works', check: 'node --test', decisions: ['D1'] }], ...extra,
})
const root = (extra = {}) => ({ id: '.', kind: 'composite', title: 'the change', defines: [{ id: 'D1', text: 'do it' }], ...extra })
const tree = (...nodes) => liveNodes(nodes.map((node, i) => ({ kind: 'node', node, seq: i + 1 })))

test('ids, parents, branches: the root is ".", nested ids are siblings of the effort branch', () => {
  assert.equal(nodeIdProblem('.'), null)
  assert.equal(nodeIdProblem('auth/session/refresh-token'), null)
  assert.match(nodeIdProblem('Auth'), /segment/)
  assert.match(nodeIdProblem('a//b'), /segment/)
  assert.match(nodeIdProblem('a.b'), /segment/)
  assert.equal(parentOf('a/b'), 'a')
  assert.equal(parentOf('a'), '.')
  assert.equal(parentOf('.'), null)
  assert.deepEqual(ancestorsOf('a/b/c'), ['a/b', 'a', '.'])
  assert.equal(branchOf('e1', '.'), 'agentics/e1')
  assert.equal(branchOf('e1', 'a/b'), 'agentics/e1--a.b')
  assert.equal(worktreeOf('/r', 'e1', 'a/b'), '/r/.claude/worktrees/e1--a.b')
  assert.equal(safeSlug('2026-09-25-fix-it'), '2026-09-25-fix-it')
  assert.equal(safeSlug('a--b'), null)
})

test('normalization fills every field and drops unknown keys', () => {
  const n = normalizeNode({ id: 'x', kind: 'leaf', bogus: 1, acceptance: ['HUMAN: looks right'] })
  assert.equal(n.bogus, undefined)
  assert.deepEqual(n.acceptance, [{ text: 'HUMAN: looks right', check: '', decisions: [] }])
  assert.equal(n.role, 'none')
  assert.equal(n.ground_known, true)
})

test('a well-formed tree has no problems', () => {
  const nodes = tree(root(), leaf('a'), leaf('b', { deps: ['a'] }))
  assert.deepEqual(treeProblems(nodes), [])
})

test('tree problems name the node and the reason', () => {
  const nodes = tree(
    root(),
    leaf('a', { deps: ['b'] }),
    leaf('b', { deps: ['a'] }),
    leaf('c', { decisions: ['D9'], acceptance: [{ text: 'x', check: '', decisions: ['D9'] }] }),
    leaf('orphan/x'),
    { id: 'd', kind: 'leaf', title: 'no rigor', locus: ['x'], acceptance: [{ text: 'y', check: 'z' }] },
  )
  const problems = treeProblems(nodes).map((p) => p.node + ': ' + p.problem).join('\n')
  assert.match(problems, /dependency cycle/)
  assert.match(problems, /c: .*names no check/)
  assert.match(problems, /realises decision D9/)
  assert.match(problems, /orphan\/x: its parent orphan is not in the tree/)
  assert.match(problems, /d: .*needs a rigor/)
})

test('a red/green/audit cycle is read from role and deps', () => {
  const nodes = tree(root(),
    leaf('r', { rigor: 'tdd-triad', role: 'red', locus: ['test/x.test.js'] }),
    leaf('g', { rigor: 'tdd-triad', role: 'green', deps: ['r'] }),
    leaf('au', { rigor: 'tdd-triad', role: 'audit', deps: ['g'], locus: ['audit.md'] }))
  assert.deepEqual(treeProblems(nodes), [])
  assert.deepEqual(cycleOf(nodes, 'g'), ['r', 'g', 'au'])
  assert.deepEqual(cycleOf(nodes, 'au'), ['r', 'g', 'au'])
  assert.equal(executorRole(nodes.get('r')), 'test-author')
  assert.equal(executorRole(nodes.get('g')), 'implementer')
  assert.equal(executorRole(nodes.get('au')), 'auditor')
  assert.equal(ownReview(nodes.get('g')), true)

  const bad = tree(root(), leaf('g', { rigor: 'tdd-pair', role: 'green' }))
  assert.match(treeProblems(bad).map((p) => p.problem).join(), /depends on exactly one red/)
})

test('a verify leaf writes nothing and has no producer', () => {
  const nodes = tree(root(), leaf('v', { rigor: 'verify', locus: [] }))
  assert.deepEqual(treeProblems(nodes), [])
  assert.equal(executorRole(nodes.get('v')), '')
})

test('status is derived: a replan clears an escalation, a merge is final', () => {
  const nodes = tree(root(), leaf('a'), leaf('b'), leaf('c'))
  const ev = (seq, kind, node, extra = {}) => ({ seq, kind, node, ...extra })
  const events = [
    ev(10, 'dispatched', 'a'), ev(11, 'approved', 'a'), ev(12, 'merged', 'a'),
    ev(13, 'dispatched', 'b'), ev(14, 'escalated', 'b'),
    ev(15, 'dispatched', 'c'), ev(16, 'escalated', 'c'), ev(17, 'replanned', 'c'),
  ]
  const s = deriveStatus(nodes, events)
  assert.equal(s.get('a').status, 'merged')
  assert.equal(s.get('b').status, 'escalated')
  assert.equal(s.get('c').status, 'planned')
  assert.equal(s.get('.').status, 'escalated')

  const all = deriveStatus(nodes, [...events, ev(20, 'merged', 'b'), ev(21, 'merged', 'c')])
  assert.equal(all.get('.').status, 'integrated')
  assert.equal(deriveStatus(nodes, [ev(30, 'landed', '.')]).get('.').status, 'landed')
})

test('traceability: an undelivered decision is a gap, an untraced criterion is reported', () => {
  const nodes = tree(root({ defines: [{ id: 'D1', text: 'x' }, { id: 'D2', text: 'y' }] }),
    leaf('a', { acceptance: [{ text: 'a', check: 'c', decisions: [] }] }))
  const out = trace(nodes)
  assert.deepEqual(out.gaps.map((g) => g.decision), ['D2'])
  assert.deepEqual(out.untraced, [{ node: 'a', criterion: 'a' }])
  assert.deepEqual(trace(tree(root())).gaps, [], 'a node with no children yet is frontier, not a gap')
})

test('atomicity: overlapping loci need an ordering, and a coupled pair is exempt', () => {
  const nodes = tree(root({ shared: ['package.json'] }),
    leaf('a', { locus: ['src/x.js'] }), leaf('b', { locus: ['src/x.js'] }),
    leaf('c', { locus: ['src/y.js'], deps: [] }), leaf('d', { locus: ['src/y.js'], deps: ['c'] }),
    leaf('e', { locus: ['package.json'] }), leaf('f', { locus: ['package.json'] }))
  assert.deepEqual(checkAtomicity(nodes, 'a').map((f) => f.condition), [3])
  assert.deepEqual(checkAtomicity(nodes, 'd'), [])
  assert.equal(coupledOf(nodes, 'e'), true)
  assert.deepEqual(checkAtomicity(nodes, 'e'), [])
})

test('atomicity: fit is computed from file sizes against the model budget', () => {
  const r = repo()
  mkdirSync(join(r, 'src'))
  writeFileSync(join(r, 'src', 'big.js'), 'x'.repeat(400000))
  const big = normalizeNode(leaf('a', { locus: ['src/big.js', 'src/new.js'] }))
  const fit = fitOf(r, big)
  assert.equal(fit.fits, false)
  assert.deepEqual(fit.files.map((f) => f.missing), [false, true])
  const nodes = tree(root(), leaf('a', { locus: ['src/big.js'] }))
  assert.deepEqual(checkAtomicity(nodes, 'a', { repo: r }).map((f) => f.condition), [7])
})

test('addNodes validates against the tree on disk, all or nothing, and logs planned/replanned', () => {
  const r = repo()
  const first = addNodes(r, 'e1', [root(), leaf('a')])
  assert.equal(first.ok, true, JSON.stringify(first.problems))
  const refused = addNodes(r, 'e1', [leaf('b', { deps: ['nope'] })])
  assert.equal(refused.ok, false)
  assert.match(refused.problems[0].problem, /depends on nope/)
  assert.equal(readTree(r, 'e1').nodes.has('b'), false)

  const again = addNodes(r, 'e1', [leaf('a', { title: 'do a better' })], { reason: 'decompose' })
  assert.equal(again.ok, true)
  const t = readTree(r, 'e1')
  assert.equal(t.nodes.get('a').title, 'do a better')
  assert.deepEqual(t.events.map((e) => e.kind + ':' + e.node), ['planned:.', 'planned:a', 'replanned:a'])
  assert.deepEqual(subtreeOf(t.nodes, '.'), ['.', 'a'])
  assert.match(renderTree(t.nodes, t.status), /a \[tdd\] — planned — do a better/)

  append(r, 'e1', 'events', { kind: 'dispatched', node: 'a', execution: 'x' })
  assert.equal(readTree(r, 'e1').status.get('a').status, 'active')
})

test('addNodes returns traceability and atomicity as warnings, not refusals', () => {
  const r = repo()
  const out = addNodes(r, 'e1', [root({ defines: [{ id: 'D1', text: 'x' }, { id: 'D2', text: 'y' }] }), leaf('a')])
  assert.equal(out.ok, true)
  assert.deepEqual(out.warnings.gaps.map((g) => g.decision), ['D2'])
})
