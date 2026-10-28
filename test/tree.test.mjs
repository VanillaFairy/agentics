import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { append } from '../lib/ledger.mjs'
import {
  addNodes, cycleOf, deriveStatus, executorRole, liveNodes, normalizeNode, ownReview, ownerOf, readTree,
  renderTree, subtreeOf, treeProblems, unitsOf,
} from '../lib/tree.mjs'
import { seedTree } from './harness/seed-tree.mjs'
import { checkAtomicity, coupledOf, fitOf, ordered } from '../lib/atomicity.mjs'
import { BYTES_PER_TOKEN } from '../lib/roles.mjs'
import { trace } from '../lib/traceability.mjs'
import { ancestorsOf, branchOf, flat, nodeIdProblem, parentOf, safeSlug, worktreeOf } from '../lib/store.mjs'

const repo = () => mkdtempSync(join(tmpdir(), 'agentics-tree-'))

const leaf = (id, extra = {}) => ({
  id, kind: 'leaf', title: 'do ' + id, rigor: 'tdd', expects: ['src/' + flat(id) + '.js'],
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
  assert.equal(worktreeOf('/r', 'e1', 'a/b'), resolve('/r').replaceAll('\\', '/') + '/.claude/worktrees/e1--a.b')
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
    { id: 'd', kind: 'leaf', title: 'no rigor', expects: ['x'], acceptance: [{ text: 'y', check: 'z' }] },
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
    leaf('r', { rigor: 'tdd-triad', role: 'red', expects: ['test/x.test.js'] }),
    leaf('g', { rigor: 'tdd-triad', role: 'green', deps: ['r'] }),
    leaf('au', { rigor: 'tdd-triad', role: 'audit', deps: ['g'], expects: ['audit.md'] }))
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
  const nodes = tree(root(), leaf('v', { rigor: 'verify', expects: [] }))
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
  assert.equal(all.get('.').status, 'reviewing')
  assert.equal(all.get('.').review, 'pending')
  const reviewed = deriveStatus(nodes, [...events, ev(20, 'merged', 'b'), ev(21, 'merged', 'c'), ev(22, 'claims', '.', { review: 'not_earned', claims: [] })])
  assert.equal(reviewed.get('.').status, 'integrated')
  assert.equal(reviewed.get('.').review, 'not_earned')
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

test('atomicity: two leaves expecting one file is no atomicity problem, and a shared file couples', () => {
  const nodes = tree(root({ shared: ['package.json', 'config/'] }),
    leaf('a', { expects: ['src/x.js'] }), leaf('b', { expects: ['src/x.js'] }),
    leaf('e', { expects: ['package.json'] }), leaf('f', { expects: ['config/app.json'] }), leaf('g', { expects: ['configs/app.json'] }))
  assert.deepEqual(checkAtomicity(nodes, 'a'), [], 'the scheduler keeps them apart; the plan need not order them')
  assert.equal(coupledOf(nodes, 'e'), true)
  assert.equal(coupledOf(nodes, 'f'), true, 'a shared directory couples every file under it')
  assert.equal(coupledOf(nodes, 'g'), false, 'a sibling that only shares the prefix is not under it')
})

test('atomicity: fit is computed from file sizes against the model budget', () => {
  const r = repo()
  mkdirSync(join(r, 'src'))
  writeFileSync(join(r, 'src', 'big.js'), 'x'.repeat(400000))
  const big = normalizeNode(leaf('a', { expects: ['src/big.js', 'src/new.js'] }))
  const fit = fitOf(r, big)
  assert.equal(fit.fits, false)
  assert.deepEqual(fit.files.map((f) => f.missing), [false, true])
  const nodes = tree(root(), leaf('a', { expects: ['src/big.js'] }))
  assert.deepEqual(checkAtomicity(nodes, 'a', { repo: r }).map((f) => f.condition), [7])
})

test('atomicity: fit estimates tokens at the bytes a token a first read measured', () => {
  const r = repo()
  mkdirSync(join(r, 'src'))
  // Fits at 3.5 bytes a token, not at the measured figure: a leaf a first read could not hold.
  writeFileSync(join(r, 'src', 'mid.js'), 'x'.repeat(300000))
  const fit = fitOf(r, normalizeNode(leaf('a', { expects: ['src/mid.js'] })), { briefBytes: 0 })
  assert.equal(fit.tokens, Math.ceil(300000 / BYTES_PER_TOKEN))
  assert.equal(fit.fits, false)
})

test('addNodes validates against the tree on disk, all or nothing, and logs planned/replanned', () => {
  const r = repo()
  const first = seedTree(r, 'e1', [root(), leaf('a')])
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
  const out = seedTree(r, 'e1', [root({ defines: [{ id: 'D1', text: 'x' }, { id: 'D2', text: 'y' }] }), leaf('a')])
  assert.equal(out.ok, true)
  assert.deepEqual(out.warnings.gaps.map((g) => g.decision), ['D2'])
})

test('an autonomous replan preserves decisions: no new or changed defines, no changed contract, no dropped decision', () => {
  const r = repo()
  assert.equal(seedTree(r, 'e1', [root(), leaf('a', { provides: [{ name: 'api', paths: ['src/a.js'] }] })]).ok, true)

  const defines = addNodes(r, 'e1', [root({ defines: [{ id: 'D1', text: 'do it differently' }] })], { by: 'planner' })
  assert.equal(defines.ok, false)
  assert.match(defines.problems.map((p) => p.problem).join(), /may not state or change a decision/)

  const contract = addNodes(r, 'e1', [leaf('a', { provides: [{ name: 'api', paths: ['src/other.js'] }] })], { by: 'planner' })
  assert.match(contract.problems.map((p) => p.problem).join(), /contract/)

  const dropped = addNodes(r, 'e1', [leaf('a', { decisions: [], acceptance: [{ text: 'x', check: 'y', decisions: [] }], provides: [{ name: 'api', paths: ['src/a.js'] }] })], { by: 'planner' })
  assert.match(dropped.problems.map((p) => p.problem).join(), /decision D1 was realised before this replan/)

  const split = addNodes(r, 'e1', [
    { id: 'a', kind: 'composite', title: 'do a', decisions: ['D1'], provides: [{ name: 'api', paths: ['src/a.js'] }] },
    leaf('a/x', { expects: ['src/a.js'] }), leaf('a/y', { expects: ['src/b.js'] }),
  ], { by: 'planner', reason: 'decompose' })
  assert.equal(split.ok, true, JSON.stringify(split.problems))

  const answered = addNodes(r, 'e1', [root({ defines: [{ id: 'D1', text: 'do it' }, { id: 'D2', text: 'the user said so' }] })], { by: 'session', reason: 'answered' })
  assert.equal(answered.ok, false, 'no session writes a decision: compile does, from an approved spec')
})

// ------------------------------------------------------------------ the node record

const compiled = (approved, extra = {}) => ({ by: 'compile', approved: new Map(Object.entries(approved)), ...extra })

test('the node record has no level and no design_doc; author defaults to you', () => {
  const n = normalizeNode({ id: 'd', kind: 'design', title: 'later', level: 'component', design_doc: 'docs/x.md' })
  assert.equal('level' in n, false)
  assert.equal('design_doc' in n, false)
  assert.equal(n.author, 'you')
  assert.equal(normalizeNode({ id: 'd', kind: 'design', title: 'later', author: 'planner' }).author, 'planner')
})

test('a design node needs no level, and renders as [design]', () => {
  const nodes = tree(root(), { id: 'd', kind: 'design', title: 'later part', decisions: ['D1'] })
  assert.deepEqual(treeProblems(nodes), [])
  assert.match(renderTree(nodes, deriveStatus(nodes, [])), /d \[design\] — open — later part/)
})

test('author is you or planner, and no leaf is authored by the planner', () => {
  const odd = treeProblems(tree(root(), { id: 'd', kind: 'design', title: 't', author: 'someone' }))
  assert.match(odd.map((p) => p.problem).join(), /author/)
  const leafy = treeProblems(tree(root(), leaf('a', { author: 'planner' })))
  assert.match(leafy.map((p) => p.problem).join(), /author|planner/)
  assert.deepEqual(treeProblems(tree(root(), { id: 'p', kind: 'composite', title: 'p', author: 'planner', decisions: ['D1'] }, leaf('p/x'))), [])
})

// ------------------------------------------------------------------ the decision guard (IL4)

test('compile writes decisions equal to the approved copy, in any order', () => {
  const r = repo()
  const defines = [{ id: 'D1', text: 'do it' }, { id: 'D2', text: 'and this' }]
  const out = addNodes(r, 'e1', [root({ defines }), leaf('a')], compiled({ '.': [...defines].reverse() }))
  assert.equal(out.ok, true, JSON.stringify(out.problems))
  assert.deepEqual(readTree(r, 'e1').nodes.get('.').defines.map((d) => d.id), ['D1', 'D2'])
})

test('compile is refused when its decisions differ from the approved copy, or there is none', () => {
  const r = repo()
  for (const approved of [
    { '.': [{ id: 'D1', text: 'do it differently' }] },
    { '.': [{ id: 'D1', text: 'do it' }, { id: 'D2', text: 'more' }] },
    {},
  ]) {
    const out = addNodes(r, 'e1', [root(), leaf('a')], compiled(approved))
    assert.equal(out.ok, false, JSON.stringify(approved))
    assert.match(out.problems.map((p) => p.problem).join(), /approved/)
  }
  assert.equal(readTree(r, 'e1').nodes.size, 0, 'nothing was written')
})

test('a changed decision is admitted from compile against the new approved copy, and from no other writer', () => {
  const r = repo()
  assert.equal(seedTree(r, 'e1', [root(), leaf('a')]).ok, true)
  const changed = [{ id: 'D1', text: 'do it the new way' }]
  for (const by of ['planner', 'session', 'user']) {
    const out = addNodes(r, 'e1', [root({ defines: changed })], { by, approved: new Map([['.', changed]]) })
    assert.equal(out.ok, false, by + ' may not change a decision, approved copy or not')
  }
  assert.equal(addNodes(r, 'e1', [root({ defines: changed })], compiled({ '.': changed })).ok, true)
  assert.equal(readTree(r, 'e1').nodes.get('.').defines[0].text, 'do it the new way')
})

test('the session has no exemption: stating a decision as the session is refused', () => {
  const r = repo()
  const out = addNodes(r, 'e1', [root(), leaf('a')], { by: 'session' })
  assert.equal(out.ok, false)
  assert.match(out.problems.map((p) => p.problem).join(), /decision/)
})

test('a node first seen in this batch cannot state a decision the approved copy lacks', () => {
  const r = repo()
  seedTree(r, 'e1', [root(), leaf('a')])
  const sneaky = { id: 'b', kind: 'composite', title: 'b', decisions: ['D1'], defines: [{ id: 'D9', text: 'mine' }] }
  const out = addNodes(r, 'e1', [sneaky, leaf('b/x')], compiled({ '.': [{ id: 'D1', text: 'do it' }] }))
  assert.equal(out.ok, false)
  assert.ok(out.problems.some((p) => p.node === 'b'))
})

test('compile may change a contract only on a node whose spec the user approved', () => {
  const r = repo()
  seedTree(r, 'e1', [root(), leaf('a', { provides: [{ name: 'api', paths: ['src/a.js'] }] })])
  const moved = leaf('a', { provides: [{ name: 'api', paths: ['src/api/'] }] })
  assert.match(addNodes(r, 'e1', [moved], compiled({})).problems.map((p) => p.problem).join(), /contract/,
    'a prepared spec cannot change a contract')
  assert.equal(addNodes(r, 'e1', [leaf('a')], { by: 'planner', owned: new Set(['a']) }).ok, false, 'owned is compile\'s alone')
  assert.equal(addNodes(r, 'e1', [moved], compiled({}, { owned: new Set(['a']) })).ok, true)
})

test('a decision a design node realises is not lost', () => {
  const r = repo()
  seedTree(r, 'e1', [root(), leaf('a')])
  const out = addNodes(r, 'e1', [{ ...leaf('a'), retired: true }, { id: 'b', kind: 'design', title: 'later', decisions: ['D1'] }], { by: 'planner' })
  assert.equal(out.ok, true, JSON.stringify(out.problems))
})

test('a decision a dropped entry gives up is accepted from compile, and from no other writer', () => {
  const r = repo()
  seedTree(r, 'e1', [root(), leaf('a')])
  const dropped = [{ ...leaf('a'), retired: true }]
  assert.match(addNodes(r, 'e1', dropped, compiled({})).problems.map((p) => p.problem).join(), /D1 was realised/)
  assert.equal(addNodes(r, 'e1', dropped, { by: 'planner', accepted: new Set(['D1']) }).ok, false)
  assert.equal(addNodes(r, 'e1', dropped, compiled({}, { accepted: new Set(['D1']) })).ok, true)
})

test('compile may not empty a node\'s decisions without an approved entry for it', () => {
  const r = repo()
  const part = { id: 'p', kind: 'composite', title: 'p', decisions: ['D1'], defines: [{ id: 'p.D1', text: 'mine' }] }
  assert.equal(seedTree(r, 'e1', [root(), leaf('a'), part, leaf('p/x')]).ok, true)
  const out = addNodes(r, 'e1', [{ ...part, defines: [] }], { by: 'compile', approved: new Map([['.', [{ id: 'D1', text: 'do it' }]]]) })
  assert.equal(out.ok, false, 'a missing entry is refused, never read as []')
  assert.match(out.problems.map((p) => p.problem).join(), /approved/)
})

test('owned admits a contract change only on the nodes it names', () => {
  const r = repo()
  seedTree(r, 'e1', [root(), leaf('a', { provides: [{ name: 'api', paths: ['src/a.js'] }] }), leaf('b', { provides: [{ name: 'web', paths: ['src/b.js'] }] })])
  const moved = leaf('a', { provides: [{ name: 'api', paths: ['src/api/'] }] })
  const out = addNodes(r, 'e1', [moved], { by: 'compile', approved: new Map(), owned: new Set(['b']) })
  assert.equal(out.ok, false)
  assert.match(out.problems.map((p) => p.problem).join(), /contract/)
})

test('a contract name is provided by one node only', () => {
  const found = treeProblems(tree(root(), leaf('a', { provides: [{ name: 'api', paths: ['src/a.js'] }] }), leaf('b', { provides: [{ name: 'api', paths: ['src/b.js'] }] })))
  assert.ok(found.some((p) => p.node === 'b' && /api/.test(p.problem)), JSON.stringify(found))
})

test('a batch may give each node its own replan reason', () => {
  const r = repo()
  seedTree(r, 'e1', [root(), leaf('a'), leaf('b')])
  const out = addNodes(r, 'e1', [leaf('a', { title: 'do a again' }), leaf('b', { title: 'do b again' })],
    compiled({}, { reason: 'compiled', reasons: new Map([['b', 'decision_changed']]) }))
  assert.equal(out.ok, true, JSON.stringify(out.problems))
  const replans = readTree(r, 'e1').events.filter((e) => e.kind === 'replanned')
  assert.deepEqual(replans.map((e) => [e.node, e.reason, e.by]), [['a', 'compiled', 'compile'], ['b', 'decision_changed', 'compile']])
})

test('a retirement is no way round the guard: a contract or a decision leaves the tree only from compile', () => {
  const r = repo()
  const provider = leaf('a', { provides: [{ name: 'api', paths: ['src/a.js'] }] })
  const part = { id: 'p', kind: 'composite', title: 'p', decisions: ['D1'], defines: [{ id: 'p.D2', text: 'the user said so' }] }
  assert.equal(seedTree(r, 'e1', [root(), provider, leaf('b'), part, leaf('p/x', { decisions: ['D1', 'p.D2'] })]).ok, true)
  const problems = (out) => out.problems.map((p) => p.problem).join()

  const moved = addNodes(r, 'e1', [{ ...provider, retired: true }, leaf('c', { provides: [{ name: 'api', paths: ['src/elsewhere/'] }] })], { by: 'planner' })
  assert.equal(moved.ok, false, 'retire the provider and add another under the same name, one batch')
  assert.match(problems(moved), /contract/)

  const alone = addNodes(r, 'e1', [{ ...provider, retired: true }], { by: 'planner' })
  assert.equal(alone.ok, false, 'a retired provider drops the contract, and a later batch could re-add it changed')
  assert.match(problems(alone), /contract/)

  const gone = addNodes(r, 'e1', [{ id: 'p', retired: true }, { id: 'p/x', retired: true }], { by: 'planner' })
  assert.equal(gone.ok, false, 'retiring the node that defines p.D2 drops the user\'s decision')
  assert.match(problems(gone), /decision/)

  const t = readTree(r, 'e1')
  assert.ok(t.nodes.has('a') && t.nodes.has('p') && !t.nodes.has('c'), 'nothing was written')

  const byCompile = addNodes(r, 'e1', [{ id: 'p', retired: true }, { id: 'p/x', retired: true }, { ...provider, retired: true }], { by: 'compile', approved: new Map() })
  assert.equal(byCompile.ok, true, JSON.stringify(byCompile.problems))
})

test('only compile sets or changes who designs a node', () => {
  const r = repo()
  const later = { id: 'd', kind: 'design', title: 'later', decisions: ['D1'] }
  assert.equal(seedTree(r, 'e1', [root(), leaf('a'), leaf('b'), later]).ok, true)
  const refused = (batch) => {
    const out = addNodes(r, 'e1', batch, { by: 'planner' })
    assert.equal(out.ok, false, JSON.stringify(batch))
    assert.match(out.problems.map((p) => p.problem).join(), /author/)
  }
  refused([{ ...later, author: 'planner' }])
  refused([{ id: 'a', kind: 'design', title: 'a', decisions: ['D1'], author: 'planner' }])
  refused([{ id: 'e', kind: 'design', title: 'more', decisions: ['D1'], author: 'planner' }])
  const out = addNodes(r, 'e1', [{ ...later, author: 'planner' }], { by: 'compile', approved: new Map() })
  assert.equal(out.ok, true, JSON.stringify(out.problems))
})

test('a replan may not drop or re-path a contract a node consumes', () => {
  const r = repo()
  assert.equal(seedTree(r, 'e1', [root(), leaf('a', { provides: [{ name: 'api', paths: ['src/a.js'] }] }),
    leaf('b', { consumes: [{ name: 'api', paths: ['src/a.js'] }] })]).ok, true)
  for (const b of [leaf('b'), leaf('b', { consumes: [{ name: 'api', paths: ['nowhere/'] }] })]) {
    const out = addNodes(r, 'e1', [b], { by: 'planner' })
    assert.equal(out.ok, false, 'consumes=' + JSON.stringify(b.consumes))
    assert.match(out.problems.map((p) => p.problem).join(), /contract/)
  }
  const out = addNodes(r, 'e1', [leaf('b')], { by: 'compile', approved: new Map(), owned: new Set(['b']) })
  assert.equal(out.ok, true, JSON.stringify(out.problems))
})

test('a replan may add a contract a node consumes, an existing one kept as it was; dropping one beside the addition is still refused', () => {
  const r = repo()
  assert.equal(seedTree(r, 'e1', [root(), leaf('a', { provides: [{ name: 'api', paths: ['src/a.js'] }] }),
    leaf('k', { provides: [{ name: 'kinds', paths: ['src/k/'] }] }),
    leaf('b', { consumes: [{ name: 'api', paths: ['src/a.js'] }] })]).ok, true)
  const added = addNodes(r, 'e1', [leaf('b', { consumes: [{ name: 'api', paths: ['src/a.js'] }, { name: 'kinds', paths: ['src/k/'] }] })], { by: 'compile', approved: new Map() })
  assert.equal(added.ok, true, JSON.stringify(added.problems))
  const swapped = addNodes(r, 'e1', [leaf('b', { consumes: [{ name: 'kinds', paths: ['src/k/'] }] })], { by: 'compile', approved: new Map() })
  assert.equal(swapped.ok, false)
  assert.match(swapped.problems.map((p) => p.problem).join(), /drop or re-path a contract this node consumes \(api\)/)
})

const group =(id, extra = {}) => ({ id, kind: 'group', title: 'gather ' + id, ...extra })

test('a group sits in a folder and holds only tasks: its owner is the folder, and its units merge there', () => {
  const nodes = tree(root(), group('g'), leaf('g/a'), leaf('g/b', { deps: ['g/a'] }), leaf('c'))
  assert.deepEqual(treeProblems(nodes), [])
  assert.equal(ownerOf(nodes, 'g/a'), '.')
  assert.equal(ownerOf(nodes, 'g'), '.')
  assert.equal(ownerOf(nodes, '.'), null)
  assert.deepEqual(unitsOf(nodes, '.'), ['c', 'g/a', 'g/b'])
  assert.match(renderTree(nodes, deriveStatus(nodes, [])), /g \[group\]/)
})

test('a group is refused inside a group or a leaf, holding a design node, or carrying anything but its tasks', () => {
  const said = (nodes, id, re) => assert.ok(treeProblems(nodes).some((p) => p.node === id && re.test(p.problem)), JSON.stringify(treeProblems(nodes)))
  said(tree(root(), group('g'), group('g/h'), leaf('g/h/a')), 'g/h', /group/)
  said(tree(root(), group('g'), { id: 'g/d', kind: 'design', title: 'later' }), 'g/d', /holds only tasks/)
  said(tree(root(), group('g', { decisions: ['D1'] }), leaf('g/a')), 'g', /only gathers/)
  said(tree(root(), group('g', { author: 'planner' }), leaf('g/a')), 'g', /no author/)
})

test('a group is merged once every task in it is, since it has no branch of its own', () => {
  const nodes = tree(root(), group('g'), leaf('g/a'), leaf('g/b'))
  const merged = (id, seq) => ({ kind: 'merged', node: id, seq })
  assert.equal(deriveStatus(nodes, [merged('g/a', 10)]).get('g').status, 'active')
  const both = deriveStatus(nodes, [merged('g/a', 10), merged('g/b', 11)])
  assert.equal(both.get('g').status, 'merged')
  assert.equal(both.get('g').review, null, 'a group has no integration review')
  assert.equal(both.get('.').status, 'reviewing')
})

test('ordering: waiting for a group, or sitting in a group that waits, orders a leaf against every task in it', () => {
  const byGroupDep = tree(root(), group('g'), leaf('g/a'), leaf('b', { deps: ['g'] }))
  assert.equal(ordered(byGroupDep, 'b', 'g/a'), true)
  const byGroupAfter = tree(root(), leaf('a'), group('g', { deps: ['a'] }), leaf('g/b'))
  assert.equal(ordered(byGroupAfter, 'g/b', 'a'), true)
  const unordered = tree(root(), group('g'), leaf('g/a'), leaf('b'))
  assert.equal(ordered(unordered, 'b', 'g/a'), false)
})

test('traceability passes through a group: a decision its tasks realise is no gap at the folder', () => {
  const nodes = tree(root(), group('g'), leaf('g/a'))
  assert.deepEqual(trace(nodes, '.').gaps, [])
})

test('a cycle through a group is refused: a dep on a group reaches its tasks, and a group\'s after binds them', () => {
  const cyclic = (nodes) => treeProblems(nodes).some((p) => /cycle/.test(p.problem))
  assert.ok(cyclic(tree(root(), leaf('u', { deps: ['g'] }), group('g'), leaf('g/t', { deps: ['u'] }))))
  assert.ok(cyclic(tree(root(), group('g', { deps: ['g/t'] }), leaf('g/t'))))
  assert.ok(!cyclic(tree(root(), leaf('u'), group('g', { deps: ['u'] }), leaf('g/t'))))
})
