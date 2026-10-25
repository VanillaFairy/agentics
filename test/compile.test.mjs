// test/compile.test.mjs — approved and prepared specs in, node revisions out: the mapping, the
// refusals, idempotence, and what a re-approval does across the effort.
//
// Design: docs/DESIGN.md#specs-approval-and-compile.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { approvalState, recordApproval, recordPreparation } from '../lib/approval.mjs'
import { compileEffort } from '../lib/compile.mjs'
import { append, fileFor, readLog } from '../lib/ledger.mjs'
import { canonical, fnv1a } from '../lib/plan-digest.mjs'
import { LABEL_MAX, hashSpec, parseSpec } from '../lib/spec.mjs'
import { snapshotOf } from '../lib/status.mjs'
import { specPath } from '../lib/store.mjs'
import { childrenOf, readTree } from '../lib/tree.mjs'

const CLI = fileURLToPath(new URL('../lib/compile.mjs', import.meta.url))
const FIXTURES = fileURLToPath(new URL('./fixtures/compile/', import.meta.url))
const read = (name) => readFileSync(join(FIXTURES, name), 'utf8').replace(/\r\n/g, '\n')
const ROOT = read('root.md')
const API = read('api.md')
const PARSE = read('api-parse.md')
const E = 'e1'

function write(repo, id, text) {
  mkdirSync(dirname(specPath(repo, E, id)), { recursive: true })
  writeFileSync(specPath(repo, E, id), text)
}
function effort(files = { '.': ROOT, api: API }) {
  const repo = mkdtempSync(join(tmpdir(), 'agentics-compile-'))
  for (const [id, text] of Object.entries(files)) write(repo, id, text)
  return repo
}
function approve(repo, id) {
  const out = recordApproval(repo, E, id)
  assert.equal(out.ok, true, out.error)
}
function prepare(repo, id) {
  const out = recordPreparation(repo, E, id, { review: 'probe-' + id.replace(/\//g, '.') + '.json' })
  assert.equal(out.ok, true, out.error)
}
function compiled(repo, opts) {
  const out = compileEffort(repo, E, opts)
  assert.equal(out.ok, true, JSON.stringify(out.problems))
  return out
}
/** Counts of every effort log, to prove a call appended nothing. */
const sizes = (repo) => ['nodes', 'events', 'ledger'].map((f) => readLog(repo, E, f).entries.length)
const nodes = (repo) => readTree(repo, E).nodes
const entryOf = (text, name) => parseSpec(text, { file: 'DESIGN.md' }).entries.find((e) => e.name === name)
const firstParagraph = (body) => body.split(/\n\s*\n/)[0].trim()
const lineIn = (text, needle) => text.split('\n').findIndex((l) => l.includes(needle)) + 1

/** The fields a leaf takes from its entry, computed from the parse. */
function assertLeafFrom(node, entry) {
  assert.equal(node.kind, 'leaf', node.id)
  assert.equal(node.title, entry.title)
  assert.equal(node.intent, entry.title)
  assert.equal(node.context, entry.context)
  assert.deepEqual(node.decisions, entry.realises)
  assert.equal(node.rigor, entry.rigor)
  assert.equal(node.role, entry.role || 'none')
  assert.deepEqual(node.expects, entry.expects)
  assert.deepEqual(node.reads, entry.reads)
  assert.deepEqual(node.acceptance, entry.criteria.map((c) => ({ text: c.text, check: c.check, decisions: entry.realises })))
}

test('an approved root and sub-effort compile to composites and leaves, each field from its spec', () => {
  const repo = effort()
  approve(repo, '.')
  approve(repo, 'api')
  const out = compiled(repo)
  const tree = nodes(repo)
  const root = parseSpec(ROOT, { file: 'DESIGN.md' })
  const api = parseSpec(API, { file: 'DESIGN.md' })

  const r = tree.get('.')
  assert.equal(r.kind, 'composite')
  assert.equal(r.title, root.title)
  assert.equal(r.intent, firstParagraph(root.sections.Intent.body))
  assert.deepEqual(r.defines, root.decisions.map(({ id, text }) => ({ id, text })))
  assert.deepEqual(r.decisions, [])
  assert.equal(r.author, 'you')

  const a = tree.get('api')
  const apiEntry = entryOf(ROOT, 'api')
  assert.equal(a.kind, 'composite')
  assert.equal(a.title, api.title)
  assert.equal(a.intent, firstParagraph(api.sections.Intent.body))
  assert.equal(a.context, apiEntry.context)
  assert.deepEqual(a.defines, api.decisions.map(({ id, text }) => ({ id, text })))
  assert.deepEqual(a.decisions, apiEntry.realises)
  assert.deepEqual(a.provides, apiEntry.provides)
  assert.deepEqual(a.ground, apiEntry.ground)
  assert.equal(a.ground_known, apiEntry.ground.length > 0)

  assertLeafFrom(tree.get('cli'), entryOf(ROOT, 'cli'))
  assertLeafFrom(tree.get('reload'), entryOf(ROOT, 'reload'))
  assertLeafFrom(tree.get('api/types'), entryOf(API, 'types'))
  assertLeafFrom(tree.get('api/parse'), entryOf(API, 'parse'))

  const tuning = tree.get('tuning')
  const tuningEntry = entryOf(ROOT, 'tuning')
  assert.equal(tuning.kind, 'design')
  assert.equal(tuning.title, tuningEntry.title)
  assert.equal(tuning.intent, tuningEntry.title)
  assert.equal(tuning.author, 'planner')
  assert.deepEqual(tuning.decisions, tuningEntry.realises)

  assert.equal(tree.has('later'), false, 'a deferred entry compiles to nothing')
  assert.deepEqual(childrenOf(tree, '.'), ['api', 'cli', 'reload', 'tuning'])
  assert.deepEqual(childrenOf(tree, 'api'), ['api/parse', 'api/types'])
  assert.deepEqual([...out.written].sort(), [...tree.keys()].sort())
})

test('a label rides its entry onto the node and into the snapshot; without one the snapshot shows the last id segment', () => {
  const label = 'CLI config file'
  const labelled = ROOT.replace('- **cli** — task · realises: D1', '- **cli** — task · label: ' + label + ' · realises: D1')
  const repo = effort({ '.': labelled, api: API })
  approve(repo, '.')
  approve(repo, 'api')
  compiled(repo)
  assert.equal(nodes(repo).get('cli').label, label)
  assert.equal('label' in nodes(repo).get('reload'), false, 'an unlabelled node carries no label, so it compares as it did')
  const shown = new Map(snapshotOf(repo, E).nodes.map((n) => [n.id, n.label]))
  assert.equal(shown.get('cli'), label)
  assert.equal(shown.get('api/parse'), 'parse')
  assert.equal(shown.get('.'), E)
  const withLabel = (text) => parseSpec(ROOT.replace('- **cli** — task · realises: D1', '- **cli** — task · label: ' + text + ' · realises: D1'), { file: 'DESIGN.md' })
  assert.equal(withLabel('x'.repeat(LABEL_MAX)).problems.some((p) => /label/.test(p.problem)), false)
  assert.ok(withLabel('x'.repeat(LABEL_MAX + 1)).problems.some((p) => /label/.test(p.problem)))
})

test('after resolves to sibling ids, and a consumed contract takes its provider\'s paths', () => {
  const repo = effort()
  approve(repo, '.')
  approve(repo, 'api')
  compiled(repo)
  const tree = nodes(repo)
  assert.deepEqual(tree.get('cli').deps, ['api'])
  assert.deepEqual(tree.get('api/parse').deps, ['api/types'])
  assert.deepEqual(tree.get('cli').consumes, entryOf(ROOT, 'api').provides)
  assert.deepEqual(tree.get('api/parse').consumes, entryOf(API, 'types').provides)
})

test('a /path in after is counted from the root folder', () => {
  const text = ROOT.replace('realises: D1 · after: api · consumes', 'realises: D1 · after: /api/types · consumes')
  const repo = effort({ '.': text, api: API })
  approve(repo, '.')
  approve(repo, 'api')
  compiled(repo)
  assert.deepEqual(nodes(repo).get('cli').deps, ['api/types'])
})

test('compiled hashes are recorded, and a second compile appends nothing anywhere', () => {
  const repo = effort()
  approve(repo, '.')
  approve(repo, 'api')
  compiled(repo)
  assert.equal(approvalState(repo, E, '.').compiled_hash, hashSpec(ROOT))
  assert.equal(approvalState(repo, E, 'api').compiled_hash, hashSpec(API))

  const before = sizes(repo)
  const again = compiled(repo)
  assert.deepEqual(again.written, [])
  assert.deepEqual(again.retired, [])
  assert.deepEqual(again.parked, [])
  assert.deepEqual(again.flagged, [])
  assert.deepEqual(sizes(repo), before)
})

test('a sub-effort whose spec is not approved is a design node at the frontier', () => {
  const repo = effort()
  approve(repo, '.')
  compiled(repo)
  const api = nodes(repo).get('api')
  assert.equal(api.kind, 'design')
  assert.deepEqual(api.decisions, entryOf(ROOT, 'api').realises)
  assert.deepEqual(api.provides, entryOf(ROOT, 'api').provides)
  assert.deepEqual(childrenOf(nodes(repo), 'api'), [])
})

test('a root that is not approved or prepared is refused, and nothing is written', () => {
  const repo = effort()
  const out = compileEffort(repo, E)
  assert.equal(out.ok, false)
  assert.ok(out.problems.some((p) => /DESIGN\.md$/.test(p.file) && /approved|prepared/.test(p.problem)))
  assert.deepEqual(sizes(repo), [0, 0, 0])
})

test('a spec edited since approval is left out, and the graph keeps its last approved revision', () => {
  const repo = effort()
  approve(repo, '.')
  approve(repo, 'api')
  compiled(repo)
  const title = nodes(repo).get('api/parse').title

  write(repo, 'api', API.replace('Parse keys case-insensitively', 'Parse keys any way at all'))
  const before = sizes(repo)
  const out = compiled(repo)
  assert.ok(out.skipped.some((s) => s.folder === 'api' && /edited/.test(s.why)))
  assert.equal(nodes(repo).get('api/parse').title, title)
  assert.equal(nodes(repo).get('api').kind, 'composite', 'the folder is not demoted to the frontier')
  assert.deepEqual(sizes(repo), before)

  write(repo, '.', ROOT.replace('Nothing else changes.', 'Nothing else changes, promise.'))
  const root = compiled(repo)
  assert.ok(root.skipped.some((s) => s.folder === '.'))
  assert.deepEqual(sizes(repo), before)
})

test("a folder whose spec is edited since approval still takes what its parent's re-approved entry says of it", () => {
  const repo = effort()
  approve(repo, '.')
  approve(repo, 'api')
  compiled(repo)
  write(repo, 'api', API.replace('Parse keys case-insensitively', 'Parse keys any way at all'))
  const parse = nodes(repo).get('api/parse')

  const root = ROOT.replace('- **api** — sub-effort · realises: D1, D2 ·', '- **api** — sub-effort · realises: D1, D2, D3 ·')
  write(repo, '.', root)
  approve(repo, '.')
  const out = compiled(repo)
  assert.ok(out.skipped.some((s) => s.folder === 'api'), 'the fixture: api is edited since approval')
  assert.deepEqual(nodes(repo).get('api').decisions, entryOf(root, 'api').realises)
  assert.equal(nodes(repo).get('api').title, parseSpec(API, { file: 'DESIGN.md' }).title, 'its own spec still says the rest')
  assert.deepEqual(nodes(repo).get('api/parse'), parse, 'the nodes below it stay as approved')
})

test('a spec that no longer checks in its place is refused at its file and line', () => {
  const repo = effort()
  approve(repo, '.')
  approve(repo, 'api')
  compiled(repo)
  // The root drops D2; api's `types` still realises it.
  const withoutD2 = ROOT.replace(/\| D2 \|.*\n/, '').replace('realises: D1, D2 ·', 'realises: D1 ·')
    .replace('- **later** — deferred · realises: D2', '- **later** — deferred · realises: D1')
    .replace('- **tuning** — sub-effort · realises: D2', '- **tuning** — sub-effort · realises: D1')
  write(repo, '.', withoutD2)
  approve(repo, '.')
  const before = sizes(repo)
  const out = compileEffort(repo, E)
  assert.equal(out.ok, false)
  assert.ok(out.problems.some((p) => /api\/DESIGN\.md$/.test(p.file) && p.line === lineIn(API, '- **types**') && /D2/.test(p.problem)))
  assert.deepEqual(sizes(repo), before)
})

test('a decision no entry realises is refused at approval, at its row, so compile never meets one', () => {
  const text = ROOT.replace('| D3 |', '| D4 | Configs are cached. | Loads are slow. |\n| D3 |')
  const repo = effort({ '.': text, api: API })
  const out = recordApproval(repo, E, '.')
  assert.equal(out.ok, false)
  assert.ok(/D4/.test(out.error) && out.error.includes('DESIGN.md:' + lineIn(text, '| D4 |') + ' '), out.error)
  assert.deepEqual(sizes(repo), [0, 0, 0])
  assert.equal(compileEffort(repo, E).ok, false, 'the root is not approved')
})

test('an after that names no node is refused at its entry', () => {
  const text = ROOT.replace('realises: D1 · after: api · consumes', 'realises: D1 · after: /api/ghost · consumes')
  const repo = effort({ '.': text, api: API })
  approve(repo, '.')
  approve(repo, 'api')
  const out = compileEffort(repo, E)
  assert.equal(out.ok, false)
  assert.ok(out.problems.some((p) => p.line === lineIn(text, '- **cli**') && /ghost/.test(p.problem)))
})

test('a task with a bad rigor is refused at approval, at the entry\'s line (I3)', () => {
  const text = ROOT.replace('consumes: config-api · rigor: tdd', 'consumes: config-api · rigor: bogus')
  const repo = effort({ '.': text, api: API })
  const out = recordApproval(repo, E, '.')
  assert.equal(out.ok, false)
  assert.match(out.error, new RegExp('DESIGN\\.md:' + lineIn(text, '- **cli**') + ' .*rigor'))
  assert.deepEqual(readLog(repo, E, 'nodes').entries, [])
})

test('a refusal only the whole tree can see (two entries providing the same contract) comes back at the entry\'s line', () => {
  const text = ROOT.replace('- **reload** — task · realises: D3 · after: api · rigor: tdd',
    '- **reload** — task · realises: D3 · after: api · provides: config-api (src/reload.js) · rigor: tdd')
  const repo = effort({ '.': text, api: API })
  approve(repo, '.')
  approve(repo, 'api')
  const out = compileEffort(repo, E)
  assert.equal(out.ok, false)
  assert.ok(out.problems.some((p) => /DESIGN\.md$/.test(p.file) && p.line === lineIn(text, '- **reload**') && /config-api/.test(p.problem)),
    JSON.stringify(out.problems))
  assert.deepEqual(readLog(repo, E, 'nodes').entries, [])
})

test('a removed entry is retired with its subtree; one with dispatched work is refused by name', () => {
  const withoutCli = ROOT.replace(/- \*\*cli\*\*[\s\S]*?(?=- \*\*reload\*\*)/, '')
  const repo = effort()
  approve(repo, '.')
  approve(repo, 'api')
  compiled(repo)
  write(repo, '.', withoutCli)
  approve(repo, '.')
  const out = compiled(repo)
  assert.deepEqual(out.retired, ['cli'])
  assert.equal(nodes(repo).has('cli'), false)

  const busy = effort()
  approve(busy, '.')
  approve(busy, 'api')
  compiled(busy)
  append(busy, E, 'events', { kind: 'dispatched', node: 'cli', execution: '20260926-120000', role: 'implementer', round: 1 })
  write(busy, '.', withoutCli)
  approve(busy, '.')
  const before = sizes(busy)
  const refused = compileEffort(busy, E)
  assert.equal(refused.ok, false)
  assert.ok(refused.problems.some((p) => /\bcli\b/.test(p.problem)))
  assert.equal(nodes(busy).has('cli'), true)
  assert.deepEqual(sizes(busy), before)
})

test('a decision given up by a dropped entry is accepted, and its leaf retired', () => {
  const dropped = ROOT.replace('- **reload** — task · realises: D3 · after: api · rigor: tdd · expects: src/reload.js, test/reload.test.js', '- **reload** — dropped · realises: D3')
    .replace(/ {2}- \[ \] a changed file reloads.*\n/, '')
  const repo = effort()
  approve(repo, '.')
  approve(repo, 'api')
  compiled(repo)
  write(repo, '.', dropped)
  approve(repo, '.')
  const out = compiled(repo)
  assert.deepEqual(out.retired, ['reload'])
})

test('a task whose own folder holds a prepared spec compiles as a composite carrying its criteria', () => {
  const repo = effort()
  approve(repo, '.')
  approve(repo, 'api')
  compiled(repo)
  write(repo, 'api/parse', PARSE)
  prepare(repo, 'api/parse')
  compiled(repo)

  const tree = nodes(repo)
  const task = entryOf(API, 'parse')
  const p = tree.get('api/parse')
  assert.equal(p.kind, 'composite')
  assert.equal(p.title, parseSpec(PARSE, { file: 'DESIGN.md' }).title)
  assert.equal(p.author, 'planner')
  assert.deepEqual(p.decisions, task.realises)
  assert.deepEqual(p.acceptance, task.criteria.map((c) => ({ text: c.text, check: c.check, decisions: task.realises })))
  assert.deepEqual(p.deps, ['api/types'])
  assert.deepEqual(p.consumes, entryOf(API, 'types').provides)
  assert.deepEqual(childrenOf(tree, 'api/parse'), ['api/parse/lookup', 'api/parse/tokens'])
  assert.deepEqual(tree.get('api/parse/lookup').deps, ['api/parse/tokens'])
  assertLeafFrom(tree.get('api/parse/tokens'), entryOf(PARSE, 'tokens'))
})

test('a promoted spec whose entries drop a decision the task realised is refused', () => {
  const lossy = PARSE.replace(/ · realises: D1/g, '')
  const repo = effort()
  approve(repo, '.')
  approve(repo, 'api')
  compiled(repo)
  write(repo, 'api/parse', lossy)
  prepare(repo, 'api/parse')
  const out = compileEffort(repo, E)
  assert.equal(out.ok, false)
  assert.ok(out.problems.some((p) => /api\/parse\/DESIGN\.md$/.test(p.file) && /D1/.test(p.problem)))
})

test('re-approving a folder that provides a contract parks its consumers outside that spec', () => {
  const repo = effort()
  approve(repo, '.')
  approve(repo, 'api')
  compiled(repo)
  write(repo, 'api', API.replace('`load(path)`, then `parse(text)`.', '`load(path)` returns a frozen object.'))
  approve(repo, 'api')
  const out = compiled(repo)
  assert.deepEqual(out.parked.map((p) => [p.node, p.reason]), [['cli', 'contract_changed']])
  const park = readTree(repo, E).events.find((e) => e.kind === 'parked' && e.node === 'cli')
  assert.equal(park.return, 'contract_changed')
  assert.match(park.question, /api\/DESIGN\.md/)
  assert.equal(readTree(repo, E).status.get('cli').status, 'parked')
  assert.notEqual(readTree(repo, E).status.get('api/parse').status, 'parked', 'its own entries were re-approved with it')
})

test('a changed decision gives every node that realises it a decision_changed revision', () => {
  const repo = effort()
  approve(repo, '.')
  approve(repo, 'api')
  compiled(repo)
  write(repo, '.', ROOT.replace('| D1 | Keys are case-insensitive. |', '| D1 | Keys are case-insensitive, and so are values. |'))
  approve(repo, '.')
  const out = compiled(repo)

  const tree = readTree(repo, E)
  const realising = [...tree.nodes.values()].filter((n) => n.decisions.includes('D1')).map((n) => n.id).sort()
  assert.deepEqual(out.flagged.map((f) => f.node).sort(), realising)
  assert.ok(out.flagged.every((f) => f.decision === 'D1'))
  const flaggedEvents = tree.events.filter((e) => e.kind === 'replanned' && e.reason === 'decision_changed').map((e) => e.node).sort()
  assert.deepEqual(flaggedEvents, realising)
  assert.equal(tree.nodes.get('.').defines.find((d) => d.id === 'D1').text, 'Keys are case-insensitive, and so are values.')
})

test('a re-approved folder with dispatched work below it is parked for the planner', () => {
  const repo = effort()
  approve(repo, '.')
  approve(repo, 'api')
  compiled(repo)
  append(repo, E, 'events', { kind: 'dispatched', node: 'api/parse', execution: '20260926-120000', role: 'implementer', round: 1 })
  write(repo, 'api', API.replace('`load(path)`, then `parse(text)`.', '`load(path)`, then `parse(text)`, then `validate()`.'))
  approve(repo, 'api')
  const out = compiled(repo)
  assert.ok(out.parked.some((p) => p.node === 'api' && p.reason === 'spec_changed'))
})

test('the first compile parks and flags nothing', () => {
  const repo = effort()
  approve(repo, '.')
  approve(repo, 'api')
  const out = compiled(repo)
  assert.deepEqual(out.parked, [])
  assert.deepEqual(out.flagged, [])
})

test('re-approving the spec that owns a parked node answers the park with a new revision', () => {
  const repo = effort()
  approve(repo, '.')
  approve(repo, 'api')
  compiled(repo)
  append(repo, E, 'events', { kind: 'parked', node: 'cli', execution: '20260926-120000', return: 'needs_decision', question: 'which loader?' })
  const rev = nodes(repo).get('cli').seq
  assert.equal(readTree(repo, E).status.get('cli').status, 'parked')

  approve(repo, '.')
  const out = compiled(repo)
  assert.deepEqual(out.answered, ['cli'])
  assert.ok(nodes(repo).get('cli').seq > rev, 'a new revision, so develop adopts it')
  assert.notEqual(readTree(repo, E).status.get('cli').status, 'parked')
  assert.deepEqual(compiled(repo).answered, [], 'answered once')
})

test('--folder compiles one subtree and leaves the rest as it is', () => {
  const repo = effort()
  approve(repo, '.')
  approve(repo, 'api')
  compiled(repo)
  write(repo, 'api', API.replace('Declare the config type', 'Declare the config types'))
  approve(repo, 'api')
  write(repo, '.', ROOT.replace('Read configs from the command line', 'Read configs from argv'))
  approve(repo, '.')
  const out = compiled(repo, { folder: 'api' })
  assert.deepEqual(out.written, ['api/types'])
  assert.equal(nodes(repo).get('cli').title, entryOf(ROOT, 'cli').title, 'the root was not recompiled')
})

test('--folder compiles a prepared planner sub-effort alone, from its parent entry', () => {
  // The planner's spec for `tuning` (root entry, author: planner): no Decisions rows; it realises D2.
  const TUNING = PARSE.replace('# Parse keys', '# Tune the messages').replace(/realises: D1/g, 'realises: D2')
  const repo = effort()
  approve(repo, '.')
  approve(repo, 'api')
  compiled(repo)
  const before = nodes(repo)
  write(repo, 'tuning', TUNING)
  prepare(repo, 'tuning')
  const out = compiled(repo, { folder: 'tuning' })

  const tree = nodes(repo)
  const entry = entryOf(ROOT, 'tuning')
  const t = tree.get('tuning')
  assert.equal(t.kind, 'composite')
  assert.equal(t.title, parseSpec(TUNING, { file: 'DESIGN.md' }).title)
  assert.equal(t.author, 'planner')
  assert.deepEqual(t.decisions, entry.realises)
  assert.deepEqual(t.defines, [])
  assert.deepEqual(childrenOf(tree, 'tuning'), ['tuning/lookup', 'tuning/tokens'])
  assert.deepEqual(tree.get('tuning/lookup').deps, ['tuning/tokens'])
  assertLeafFrom(tree.get('tuning/tokens'), entryOf(TUNING, 'tokens'))
  assert.ok(out.written.every((id) => id === 'tuning' || id.startsWith('tuning/')), JSON.stringify(out.written))
  for (const id of ['.', 'api', 'cli', 'reload', 'api/types', 'api/parse']) assert.equal(tree.get(id).seq, before.get(id).seq, id + ' untouched')
  assert.equal(approvalState(repo, E, 'tuning').compiled_hash, hashSpec(TUNING))
})

test('--folder compiles a promoted task\'s folder alone, from the task\'s entry', () => {
  const repo = effort()
  approve(repo, '.')
  approve(repo, 'api')
  compiled(repo)
  const before = nodes(repo)
  write(repo, 'api/parse', PARSE)
  prepare(repo, 'api/parse')
  const out = compiled(repo, { folder: 'api/parse' })

  const tree = nodes(repo)
  const task = entryOf(API, 'parse')
  const p = tree.get('api/parse')
  assert.equal(p.kind, 'composite')
  assert.equal(p.author, 'planner')
  assert.deepEqual(p.decisions, task.realises)
  assert.deepEqual(p.acceptance, task.criteria.map((c) => ({ text: c.text, check: c.check, decisions: task.realises })))
  assert.deepEqual(p.deps, ['api/types'], 'its after resolves among the task\'s siblings')
  assert.deepEqual(p.consumes, entryOf(API, 'types').provides)
  assert.deepEqual(childrenOf(tree, 'api/parse'), ['api/parse/lookup', 'api/parse/tokens'])
  assert.ok(out.written.every((id) => id === 'api/parse' || id.startsWith('api/parse/')), JSON.stringify(out.written))
  for (const id of ['.', 'api', 'cli', 'api/types']) assert.equal(tree.get(id).seq, before.get(id).seq, id + ' untouched')
})

test('the CLI prints the result under its digest and exits 0 on a refusal', () => {
  const repo = effort()
  const refused = JSON.parse(execFileSync(process.execPath, [CLI, '--repo', repo, '--effort', E], { encoding: 'utf8' }))
  assert.equal(refused.payload.ok, false)
  assert.equal(refused.payload_digest, fnv1a(canonical(refused.payload)))
  approve(repo, '.')
  const ok = JSON.parse(execFileSync(process.execPath, [CLI, '--repo', repo, '--effort', E, '--folder', '.'], { encoding: 'utf8' }))
  assert.equal(ok.payload.ok, true)
})

/** Run `fn` with the effort's `name` log read-only, so an append to it fails. */
function readOnly(repo, name, fn) {
  const path = fileFor(repo, E, name).path
  chmodSync(path, 0o444)
  try {
    return fn()
  } finally {
    chmodSync(path, 0o666)
  }
}
const parksOf = (repo, node) => readTree(repo, E).events.filter((e) => e.kind === 'parked' && e.node === node)
const reapproveApi = (repo) => {
  write(repo, 'api', API.replace('`load(path)`, then `parse(text)`.', '`load(path)` returns a frozen object.'))
  approve(repo, 'api')
}

test('a merged consumer is not parked when the spec providing its contract is re-approved', () => {
  const repo = effort()
  approve(repo, '.')
  approve(repo, 'api')
  compiled(repo)
  append(repo, E, 'events', { kind: 'merged', node: 'cli', execution: '20260926-120000' })
  reapproveApi(repo)
  const out = compiled(repo)
  assert.equal(out.parked.some((p) => p.node === 'cli'), false)
  assert.equal(readTree(repo, E).status.get('cli').status, 'merged')
})

test('an approval older than a park does not answer it', () => {
  const repo = effort()
  approve(repo, '.')
  approve(repo, 'api')
  compiled(repo)
  write(repo, '.', ROOT.replace('Nothing else changes.', 'Nothing else changes, really.'))
  approve(repo, '.')
  append(repo, E, 'events', { kind: 'parked', node: 'cli', execution: '20260926-120000', return: 'needs_decision', question: 'which loader?' })
  const out = compiled(repo)
  assert.equal(out.answered.includes('cli'), false)
  assert.equal(readTree(repo, E).status.get('cli').status, 'parked')
})

test('a composite\'s park is answered by approving its own spec', () => {
  const repo = effort()
  approve(repo, '.')
  approve(repo, 'api')
  compiled(repo)
  append(repo, E, 'events', { kind: 'parked', node: 'api', execution: '20260926-120000', return: 'needs_decision', question: 'which parser?' })
  approve(repo, 'api')
  const out = compiled(repo)
  assert.ok(out.answered.includes('api'), JSON.stringify(out.answered))
  assert.notEqual(readTree(repo, E).status.get('api').status, 'parked')
})

test('a prepared spec may not move a contract its entry provides', () => {
  const TUNING = PARSE.replace('# Parse keys', '# Tune the messages').replace(/realises: D1/g, 'realises: D2')
    .replace('expects: src/api/tokens.js, test/tokens.test.js', 'expects: src/api/tokens.js, test/tokens.test.js · provides: tune-tokens (src/tune/tokens.js)')
  const repo = effort()
  approve(repo, '.')
  approve(repo, 'api')
  write(repo, 'tuning', TUNING)
  prepare(repo, 'tuning')
  compiled(repo)
  const moved = TUNING.replace('(src/tune/tokens.js)', '(src/tune/lexer.js)')
  write(repo, 'tuning', moved)
  prepare(repo, 'tuning')
  const before = sizes(repo)
  const out = compileEffort(repo, E)
  assert.equal(out.ok, false)
  assert.ok(out.problems.some((p) => /tuning\/DESIGN\.md$/.test(p.file) && p.line === lineIn(moved, '- **tokens**')), JSON.stringify(out.problems))
  assert.deepEqual(sizes(repo), before)
})

test('a dropped entry in a prepared spec does not give up the decision it realised', () => {
  const api = API.replace('realises: D2, api.D1', 'realises: api.D1')
  const TUNING = PARSE.replace('# Parse keys', '# Tune the messages').replace(/realises: D1/g, 'realises: D2')
  const repo = effort({ '.': ROOT, api })
  approve(repo, '.')
  approve(repo, 'api')
  write(repo, 'tuning', TUNING)
  prepare(repo, 'tuning')
  compiled(repo)
  const gaveUp = TUNING.replace('- **tokens** — task · realises: D2 · rigor: tdd · expects: src/api/tokens.js, test/tokens.test.js', '- **tokens** — dropped · realises: D2')
    .replace(/ {2}- \[ \] tokens split on newlines.*\n/, '')
    .replace('- **lookup** — task · realises: D2 · after: tokens ·', '- **lookup** — task ·')
  write(repo, 'tuning', gaveUp)
  prepare(repo, 'tuning')
  const before = sizes(repo)
  const out = compileEffort(repo, E)
  assert.equal(out.ok, false, JSON.stringify(out))
  assert.ok(out.problems.some((p) => /D2/.test(p.problem)), JSON.stringify(out.problems))
  assert.deepEqual(sizes(repo), before)
})

test('a removed entry with merged work is refused by name', () => {
  const withoutCli = ROOT.replace(/- \*\*cli\*\*[\s\S]*?(?=- \*\*reload\*\*)/, '')
  const repo = effort()
  approve(repo, '.')
  approve(repo, 'api')
  compiled(repo)
  append(repo, E, 'events', { kind: 'merged', node: 'cli', execution: '20260926-120000' })
  write(repo, '.', withoutCli)
  approve(repo, '.')
  const before = sizes(repo)
  const out = compileEffort(repo, E)
  assert.equal(out.ok, false)
  assert.ok(out.problems.some((p) => /\bcli\b/.test(p.problem)))
  assert.equal(nodes(repo).has('cli'), true)
  assert.deepEqual(sizes(repo), before)
})

test('--folder is refused when the parent spec is edited since approval', () => {
  const repo = effort()
  approve(repo, '.')
  approve(repo, 'api')
  compiled(repo)
  write(repo, 'api', API.replace('Declare the config type', 'Declare the config types'))
  approve(repo, 'api')
  write(repo, '.', ROOT.replace('Nothing else changes.', 'Nothing else changes, really.'))
  const before = sizes(repo)
  const out = compileEffort(repo, E, { folder: 'api' })
  assert.equal(out.ok, false)
  assert.ok(out.problems.some((p) => /DESIGN\.md$/.test(p.file)))
  assert.deepEqual(sizes(repo), before)
})

test('an after naming an entry dropped in the same re-approval is refused at its entry', () => {
  const repo = effort()
  approve(repo, '.')
  approve(repo, 'api')
  compiled(repo)
  const text = ROOT.replace('realises: D1 · after: api · consumes', 'realises: D1 · after: reload · consumes')
    .replace('- **reload** — task · realises: D3 · after: api · rigor: tdd · expects: src/reload.js, test/reload.test.js', '- **reload** — dropped · realises: D3')
    .replace(/ {2}- \[ \] a changed file reloads.*\n/, '')
  write(repo, '.', text)
  approve(repo, '.')
  const before = sizes(repo)
  const out = compileEffort(repo, E)
  assert.equal(out.ok, false)
  assert.ok(out.problems.some((p) => p.line === lineIn(text, '- **cli**') && /reload/.test(p.problem)), JSON.stringify(out.problems))
  assert.deepEqual(sizes(repo), before)
})

test('reordering a spec\'s decisions and entries flags, parks and rewrites no leaf, and the next compile appends nothing', () => {
  const repo = effort()
  approve(repo, '.')
  approve(repo, 'api')
  compiled(repo)
  const cli = ROOT.match(/- \*\*cli\*\*[\s\S]*?(?=- \*\*reload\*\*)/)[0]
  const reordered = ROOT.replace(/(\| D1 .*\n)(\| D2 .*\n)(\| D3 .*\n)/, '$3$2$1')
    .replace(cli, '').replace('\n## Open questions', cli + '\n## Open questions')
  assert.notEqual(reordered, ROOT)
  write(repo, '.', reordered)
  approve(repo, '.')
  const out = compiled(repo)
  assert.deepEqual(out.flagged, [])
  assert.deepEqual(out.parked, [])
  const leaves = [...nodes(repo).values()].filter((n) => n.kind === 'leaf').map((n) => n.id)
  assert.deepEqual(out.written.filter((id) => leaves.includes(id)), [])
  const before = sizes(repo)
  assert.deepEqual(compiled(repo).written, [])
  assert.deepEqual(sizes(repo), before)
})

test('parks that failed to land are appended by the next compile, once', () => {
  const repo = effort()
  approve(repo, '.')
  approve(repo, 'api')
  compiled(repo)
  reapproveApi(repo)
  const failed = readOnly(repo, 'events', () => compileEffort(repo, E))
  assert.equal(failed.ok, false)
  assert.equal(parksOf(repo, 'cli').length, 0)
  assert.notEqual(approvalState(repo, E, 'api').compiled_hash, approvalState(repo, E, 'api').hash)

  compiled(repo)
  assert.equal(parksOf(repo, 'cli').length, 1)
  assert.equal(approvalState(repo, E, 'api').compiled_hash, approvalState(repo, E, 'api').hash)
})

/** The root and api fixtures with `reload` providing a contract that api's `parse` consumes. */
const HOOKED_ROOT = ROOT.replace('expects: src/reload.js, test/reload.test.js', 'expects: src/reload.js, test/reload.test.js · provides: reload-hook (src/reload.js)')
const HOOKED_API = API.replace('consumes: config-type', 'consumes: config-type, reload-hook')

test('renaming a contract parks its consumer in a folder edited since approval', () => {
  const repo = effort({ '.': HOOKED_ROOT, api: HOOKED_API })
  approve(repo, '.')
  approve(repo, 'api')
  compiled(repo)
  write(repo, 'api', HOOKED_API.replace('Use the existing tokenizer.', 'Use the new tokenizer.'))
  write(repo, '.', HOOKED_ROOT.replace('provides: reload-hook (src/reload.js)', 'provides: hook (src/reload.js)'))
  approve(repo, '.')
  const out = compiled(repo)
  assert.ok(out.parked.some((p) => p.node === 'api/parse' && p.reason === 'contract_changed'), JSON.stringify(out.parked))
  assert.equal(readTree(repo, E).status.get('api/parse').status, 'parked')
})

test('removing a contract parks its consumer in a folder edited since approval', () => {
  const repo = effort({ '.': HOOKED_ROOT, api: HOOKED_API })
  approve(repo, '.')
  approve(repo, 'api')
  compiled(repo)
  write(repo, 'api', HOOKED_API.replace('Use the existing tokenizer.', 'Use the new tokenizer.'))
  write(repo, '.', HOOKED_ROOT.replace(' · provides: reload-hook (src/reload.js)', ''))
  approve(repo, '.')
  const out = compiled(repo)
  assert.ok(out.parked.some((p) => p.node === 'api/parse' && p.reason === 'contract_changed'), JSON.stringify(out.parked))
})

test('renaming a contract under --folder parks its consumer outside that folder', () => {
  const root = ROOT.replace('realises: D3 · after: api · rigor: tdd', 'realises: D3 · after: api · consumes: config-type · rigor: tdd')
  const repo = effort({ '.': root, api: API })
  approve(repo, '.')
  approve(repo, 'api')
  compiled(repo)
  write(repo, 'api', API.replace('provides: config-type (src/api/types.js)', 'provides: cfg-type (src/api/types.js)').replace('consumes: config-type', 'consumes: cfg-type'))
  approve(repo, 'api')
  const out = compiled(repo, { folder: 'api' })
  assert.ok(out.parked.some((p) => p.node === 'reload' && p.reason === 'contract_changed'), JSON.stringify(out.parked))
})

test('parks that landed are not appended again when the compiled line failed', () => {
  const repo = effort()
  approve(repo, '.')
  approve(repo, 'api')
  compiled(repo)
  reapproveApi(repo)
  const failed = readOnly(repo, 'ledger', () => compileEffort(repo, E))
  assert.equal(failed.ok, false)
  assert.equal(parksOf(repo, 'cli').length, 1)

  compiled(repo)
  assert.equal(parksOf(repo, 'cli').length, 1, 'the park from the failed run already landed')
  assert.equal(approvalState(repo, E, 'api').compiled_hash, approvalState(repo, E, 'api').hash)
})

test('decision_changed revisions whose events failed to land are flagged again by the next compile', () => {
  const repo = effort()
  approve(repo, '.')
  approve(repo, 'api')
  compiled(repo)
  write(repo, '.', ROOT.replace('| D1 | Keys are case-insensitive. |', '| D1 | Keys are case-insensitive, and so are values. |'))
  approve(repo, '.')
  const failed = readOnly(repo, 'events', () => compileEffort(repo, E))
  assert.equal(failed.ok, false)

  const out = compiled(repo)
  const realising = [...nodes(repo).values()].filter((n) => n.decisions.includes('D1')).map((n) => n.id).sort()
  assert.deepEqual(out.flagged.map((f) => f.node).sort(), realising)
  const flaggedEvents = readTree(repo, E).events.filter((e) => e.kind === 'replanned' && e.reason === 'decision_changed').map((e) => e.node).sort()
  assert.deepEqual(flaggedEvents, realising)
})

test('a promoted task whose spec is deleted falls back to its leaf, and the promoted nodes retire', () => {
  const repo = effort()
  approve(repo, '.')
  approve(repo, 'api')
  compiled(repo)
  write(repo, 'api/parse', PARSE)
  prepare(repo, 'api/parse')
  compiled(repo)
  rmSync(specPath(repo, E, 'api/parse'))
  const out = compiled(repo)
  assertLeafFrom(nodes(repo).get('api/parse'), entryOf(API, 'parse'))
  assert.deepEqual([...out.retired].sort(), ['api/parse/lookup', 'api/parse/tokens'])
  assert.deepEqual(childrenOf(nodes(repo), 'api/parse'), [])
})

test('a sub-effort whose approved spec is deleted is refused at its entry, never skipped as edited', () => {
  const repo = effort()
  approve(repo, '.')
  approve(repo, 'api')
  compiled(repo)
  rmSync(specPath(repo, E, 'api'))
  const before = sizes(repo)
  const out = compileEffort(repo, E)
  assert.equal(out.ok, false)
  assert.ok(out.problems.some((p) => /DESIGN\.md$/.test(p.file) && p.line === lineIn(ROOT, '- **api**')), JSON.stringify(out.problems))
  assert.equal(out.skipped.some((s) => s.folder === 'api'), false)
  assert.equal(nodes(repo).get('api').kind, 'composite')
  assert.deepEqual(sizes(repo), before)
})

test('a deleted spec with dispatched work below it is refused by name', () => {
  const repo = effort()
  approve(repo, '.')
  approve(repo, 'api')
  compiled(repo)
  write(repo, 'api/parse', PARSE)
  prepare(repo, 'api/parse')
  compiled(repo)
  append(repo, E, 'events', { kind: 'dispatched', node: 'api/parse/tokens', execution: '20260926-120000', role: 'implementer', round: 1 })
  rmSync(specPath(repo, E, 'api/parse'))
  const before = sizes(repo)
  const out = compileEffort(repo, E)
  assert.equal(out.ok, false)
  assert.ok(out.problems.some((p) => p.problem.includes('api/parse/tokens')), JSON.stringify(out.problems))
  assert.equal(nodes(repo).get('api/parse').kind, 'composite')
  assert.deepEqual(sizes(repo), before)
})

test('re-approving the root with dispatched work below it does not park the root', () => {
  const repo = effort()
  approve(repo, '.')
  approve(repo, 'api')
  compiled(repo)
  append(repo, E, 'events', { kind: 'dispatched', node: 'cli', execution: '20260926-120000', role: 'implementer', round: 1 })
  write(repo, '.', ROOT.replace('Nothing else changes.', 'Nothing else changes, really.'))
  approve(repo, '.')
  const out = compiled(repo)
  assert.equal(out.parked.some((p) => p.node === '.'), false, JSON.stringify(out.parked))
  assert.notEqual(readTree(repo, E).status.get('.').status, 'parked')
})

// ------------------------------------------------------------------ groups

const WATCH = [
  '### watch — group · after: api',
  'Watch configs for change',
  '',
  '- **reload** — task · realises: D3 · rigor: tdd · expects: src/reload.js, test/reload.test.js',
  '  Reload configs on change',
  '  - [ ] a changed file reloads — check: `node --test test/reload.test.js`',
  '- **notify** — task · realises: D3 · after: reload · rigor: tdd · expects: src/notify.js, test/notify.test.js',
  '  Tell the user a config reloaded',
  '  - [ ] a reload notifies — check: `node --test test/notify.test.js`',
  '',
].join('\n')
const GROUPED = ROOT.replace(/- \*\*reload\*\*[\s\S]*?(?=- \*\*later\*\*)/, '')
  .replace('\n## Open questions', '\n' + WATCH + '\n## Open questions')

test('a group compiles to a group node in its folder, its tasks to leaves under it, and after resolves through the plan\'s names', () => {
  const repo = effort({ '.': GROUPED.replace('after: api · consumes', 'after: api, watch · consumes'), api: API })
  approve(repo, '.')
  approve(repo, 'api')
  compiled(repo)
  const tree = nodes(repo)
  const g = tree.get('watch')
  assert.equal(g.kind, 'group')
  assert.equal(g.title, 'Watch configs for change')
  assert.deepEqual(g.deps, ['api'])
  assert.deepEqual(childrenOf(tree, 'watch'), ['watch/notify', 'watch/reload'])
  assertLeafFrom(tree.get('watch/reload'), entryOf(GROUPED, 'reload'))
  assert.deepEqual(tree.get('watch/notify').deps, ['watch/reload'], 'a name in the group resolves to its id under the group')
  assert.deepEqual(tree.get('cli').deps, ['api', 'watch'], 'an entry may wait for a whole group')
})

test('regrouping retires the flat leaves and adds them under the group, while nothing under them was dispatched', () => {
  const repo = effort()
  approve(repo, '.')
  approve(repo, 'api')
  compiled(repo)
  write(repo, '.', GROUPED)
  approve(repo, '.')
  const out = compiled(repo)
  assert.deepEqual(out.retired, ['reload'])
  assert.ok(['watch', 'watch/reload', 'watch/notify'].every((id) => out.written.includes(id)), JSON.stringify(out.written))
  write(repo, '.', ROOT)
  approve(repo, '.')
  assert.deepEqual(compiled(repo).retired.sort(), ['watch', 'watch/notify', 'watch/reload'])
})

test('a task promoted inside a group compiles as a composite under the group, alone or with the rest', () => {
  const promoted = PARSE.replace(/realises: D1/g, 'realises: D3')
  for (const opts of [undefined, { folder: 'watch/reload' }]) {
    const repo = effort({ '.': GROUPED, api: API })
    approve(repo, '.')
    approve(repo, 'api')
    compiled(repo)
    write(repo, 'watch/reload', promoted)
    prepare(repo, 'watch/reload')
    compiled(repo, opts)
    const tree = nodes(repo)
    const p = tree.get('watch/reload')
    assert.equal(p.kind, 'composite')
    assert.equal(p.author, 'planner')
    assert.deepEqual(p.deps, [])
    assert.deepEqual(childrenOf(tree, 'watch/reload'), ['watch/reload/lookup', 'watch/reload/tokens'])
    assert.deepEqual(tree.get('watch/notify').deps, ['watch/reload'])
  }
})

test('a group may not take the name of a task with merged work', () => {
  const repo = effort()
  approve(repo, '.')
  approve(repo, 'api')
  compiled(repo)
  append(repo, E, 'events', { kind: 'merged', node: 'reload', execution: '20260926-120000' })
  write(repo, '.', GROUPED.replace('### watch — group', '### reload — group').replace(/- \*\*reload\*\*/, '- **reload-core**').replace('after: reload ·', 'after: reload-core ·'))
  approve(repo, '.')
  const out = compileEffort(repo, E)
  assert.equal(out.ok, false)
  assert.ok(out.problems.some((p) => /takes the name/.test(p.problem)), JSON.stringify(out.problems))
})

test('the compile CLI refuses a value that is not a handle, and a flag it does not take', () => {
  const refusal = (...args) => {
    try {
      execFileSync(process.execPath, [CLI, ...args], {
        encoding: 'utf8', stdio: 'pipe', env: { ...process.env, NODE_TEST_CONTEXT: '' }, timeout: 30_000,
      })
      return [0, '']
    } catch (err) {
      return [err.status, JSON.parse(err.stdout).kind]
    }
  }
  assert.deepEqual(refusal('--repo', '.', '--effort', 'e`1'), [1, 'args_unreadable'])
  assert.deepEqual(refusal('--repo', '.', '--effort', 'e1', '--force'), [1, 'unknown_flag'])
})
