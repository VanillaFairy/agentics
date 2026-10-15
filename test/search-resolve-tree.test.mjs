// test/search-resolve-tree.test.mjs — the ground table over a real repository: which named paths
// exist, where each named identifier is defined and referenced, what an effort's diff changed, and
// the guidance a search is seeded with.
//
// Design: docs/DESIGN.md#searches and docs/DESIGN.md#p2--code-does-what-is-deterministic-models-only-judge.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { groundTable } from '../lib/search/resolve.mjs'
import { isTestKey, keyOf, refs } from '../lib/search/tools.mjs'
import { commit, git, gitRepo, write } from './harness/evidence-fixture.mjs'

const FILES = {
  'CLAUDE.md': '# Guidance\n',
  'tools/AGENTS.md': '# Agents\n',
  'docs/REVIEW.md': '# Review\n',
  'docs/kb/GOTCHAS.md': '# Gotchas\n',
  'src/drop/stall.ts': "import { ITEM_STAND } from '../data/items.ts'\nexport class StallOffer {\n  offer() { return ITEM_STAND }\n}\n",
  'src/drop/INDEX.md': '# drop\n',
  'src/data/items.ts': "export const ITEM_STAND = 'stand'\nexport const config = {}\n",
  'src/data/data.md': '# data\n',
  'src/app/[id]/page.tsx': 'export default function Page() { return config }\n',
  'src/util/a.ts': 'config\n', 'src/util/b.ts': 'config\n', 'src/util/c.ts': 'config\n',
  'test/drop.test.ts': "import { ITEM_STAND } from '../src/data/items.ts'\n// ITEM_STAND again\n",
  'tools/seat.py': 'def seat_day():\n    return 1\n',
  'data/words.json': '{\n  "QUEST_WORDS": ["hi"]\n}\n',
}

const TEXT = [
  'The stall (`src/drop/stall.ts`) reads `src/data/items.ts` and offers `ITEM_STAND` through StallOffer;',
  'the route src/app/[id]/page.tsx reads `config`. `seat_day` seats the guests and QUEST_WORDS feed the',
  'clips. The draft src/drop/draft.ts and the vendored vendor/lib/a.ts come in; src/drop/new.ts does not',
  'exist yet, nor does `NEVER_DEFINED`. See GOTCHAS.md and SPEC.md.',
].join('\n')
const MATERIAL = { label: 'docs/drop/DESIGN.md', text: TEXT, asks: ['ground:intro'] }

let world = null
function repo() {
  if (world) return world
  const dir = gitRepo(FILES)
  write(dir, 'src/drop/draft.ts', 'export const draft = 1\n')          // untracked
  write(dir, 'vendor/lib/a.ts', 'export const vendored = 1\n')
  git(dir, '-C', 'vendor/lib', 'init', '-q', '.')                    // a nested repository
  world = { root: dir.split('\\').join('/'), sha: git(dir, 'rev-parse', 'HEAD') }
  return world
}
const rowsOf = (t, kind) => t.rows.filter((r) => r.kind === kind)
const row = (t, kind, mention) => t.rows.find((r) => r.kind === kind && r.mention === mention)

test('a named path resolves to its key and exists; an untracked file exists; a path the tree lacks, or one inside a nested repository, does not', async () => {
  const t = await groundTable(repo(), { material: [MATERIAL] })
  for (const p of ['src/drop/stall.ts', 'src/data/items.ts', 'src/app/[id]/page.tsx', 'src/drop/draft.ts']) {
    assert.deepEqual([row(t, 'path', p).key, row(t, 'path', p).exists], [p, true], p)
  }
  for (const p of ['src/drop/new.ts', 'vendor/lib/a.ts']) assert.equal(row(t, 'path', p).exists, false, p)
})

test("a symbol's definition sites are found per language, its references counted by file with tests apart", async () => {
  const t = await groundTable(repo(), { material: [MATERIAL] })
  const stand = row(t, 'symbol', 'ITEM_STAND')
  assert.deepEqual(stand.defs, [{ key: 'src/data/items.ts', line: 1 }])
  assert.deepEqual(stand.refs.map((r) => [r.key, r.test]).sort(), [['src/data/items.ts', false], ['src/drop/stall.ts', false], ['test/drop.test.ts', true]])
  assert.equal(stand.files, stand.refs.length)
  assert.equal(stand.exists, true)
  assert.deepEqual(row(t, 'symbol', 'StallOffer').defs, [{ key: 'src/drop/stall.ts', line: 2 }])
  assert.deepEqual(row(t, 'symbol', 'seat_day').defs, [{ key: 'tools/seat.py', line: 1 }])
  assert.deepEqual(row(t, 'symbol', 'QUEST_WORDS').defs, [{ key: 'data/words.json', line: 2 }])
})

test('an identifier found nowhere is a row that does not exist', async () => {
  const t = await groundTable(repo(), { material: [MATERIAL] })
  assert.deepEqual(row(t, 'symbol', 'NEVER_DEFINED'), { kind: 'symbol', mention: 'NEVER_DEFINED', key: 'NEVER_DEFINED', exists: false, asks: ['ground:intro'], defs: [], refs: [], files: 0 })
})

test('rows rank every missing row after every existing one, and identifiers by how few files mention them', async () => {
  const t = await groundTable(repo(), { material: [MATERIAL] })
  const firstMissing = t.rows.findIndex((r) => !r.exists)
  assert.ok(firstMissing > 0)
  assert.ok(t.rows.slice(firstMissing).every((r) => !r.exists), 'nothing that exists ranks after a missing row')
  const symbols = t.rows.filter((r) => r.kind === 'symbol' && r.exists)
  for (let i = 1; i < symbols.length; i++) assert.ok(symbols[i - 1].files <= symbols[i].files, symbols[i - 1].mention + ' before ' + symbols[i].mention)
  assert.ok(symbols.findIndex((r) => r.mention === 'ITEM_STAND') < symbols.findIndex((r) => r.mention === 'config'), 'the rare identifier first')
  assert.deepEqual(t.rows.filter((r) => r.kind === 'path' && r.exists).map((r) => r.key), ['src/drop/stall.ts', 'src/data/items.ts', 'src/app/[id]/page.tsx', 'src/drop/draft.ts'], 'existing paths in mention order')
  assert.deepEqual(t.rows.filter((r) => r.kind === 'path' && !r.exists).map((r) => r.mention), ['vendor/lib/a.ts', 'src/drop/new.ts'], 'missing paths in mention order')
})

test('a bare document name resolves to every file of that name, and to a missing row when there is none', async () => {
  const t = await groundTable(repo(), { material: [MATERIAL] })
  assert.deepEqual(rowsOf(t, 'doc').filter((r) => r.mention === 'GOTCHAS.md').map((r) => [r.key, r.exists]), [['docs/kb/GOTCHAS.md', true]])
  assert.deepEqual(rowsOf(t, 'doc').filter((r) => r.mention === 'SPEC.md').map((r) => r.exists), [false])
})

test('seeds hold every CLAUDE.md and AGENTS.md, the configured guidance that exists, docs/**/*.md, and the INDEX.md or module .md beside each resolved path, once each', async () => {
  const t = await groundTable(repo(), { material: [MATERIAL], config: { guidance: ['docs/REVIEW.md', 'missing/RULES.md'] } })
  for (const k of ['CLAUDE.md', 'tools/AGENTS.md', 'docs/REVIEW.md', 'docs/kb/GOTCHAS.md', 'src/drop/INDEX.md', 'src/data/data.md']) assert.ok(t.seeds.includes(k), k)
  assert.equal(t.seeds.includes('missing/RULES.md'), false)
  assert.equal(new Set(t.seeds).size, t.seeds.length)
  assert.equal(t.rows.some((r) => r.key === 'CLAUDE.md' || r.key === 'tools/AGENTS.md'), false, 'guidance is never a row')
})

test('a row carries the asks of every material item that named it, and none when only context named it', async () => {
  const t = await groundTable(repo(), { material: [
    { label: 'section one', text: 'The stall (`src/drop/stall.ts`) offers `ITEM_STAND`.', asks: ['ground:one'] },
    { label: 'section two', text: 'Again `ITEM_STAND`, and `config`.', asks: ['ground:two'] },
    { label: 'the question', text: 'What reads `config` and src/data/items.ts?' },
  ] })
  assert.deepEqual(row(t, 'path', 'src/drop/stall.ts').asks, ['ground:one'])
  assert.deepEqual(row(t, 'symbol', 'ITEM_STAND').asks, ['ground:one', 'ground:two'])
  assert.deepEqual(row(t, 'symbol', 'config').asks, ['ground:two'])
  assert.deepEqual(row(t, 'path', 'src/data/items.ts').asks, [])
})

test('definitions and references stay inside the scope', async () => {
  const t = await groundTable(repo(), { material: [MATERIAL], scope: ['src'] })
  assert.deepEqual(row(t, 'symbol', 'seat_day').defs, [])
  assert.equal(row(t, 'symbol', 'seat_day').exists, false)
  assert.equal(row(t, 'symbol', 'ITEM_STAND').refs.some((r) => r.key.startsWith('test/')), false)
})

test("an effort's diff adds a change row per file it names and a symbol row per identifier its lines add or remove", async () => {
  const dir = gitRepo(FILES)
  const base = git(dir, 'rev-parse', 'HEAD')
  write(dir, 'src/data/items.ts', FILES['src/data/items.ts'] + 'export const NEW_THING = 1\n')
  git(dir, 'rm', '-q', 'tools/seat.py')
  const head = commit(dir)
  const t = await groundTable({ root: dir.split('\\').join('/'), sha: head }, { material: [], diff: { base, head } })
  assert.deepEqual(rowsOf(t, 'change').map((r) => [r.key, r.exists, r.asks]).sort(), [['src/data/items.ts', true, []], ['tools/seat.py', false, []]])
  assert.deepEqual(row(t, 'symbol', 'NEW_THING').defs, [{ key: 'src/data/items.ts', line: 3 }])
  assert.deepEqual(row(t, 'symbol', 'NEW_THING').asks, [], 'an identifier the diff names is context: it opens no frontier')
  assert.equal(row(t, 'symbol', 'seat_day').exists, false, 'the removed function is named, and gone')
})

// ---- added by the test author: invariants the cases above leave to chance ----

const deepFreeze = (v) => {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const x of Object.values(v)) deepFreeze(x) }
  return v
}
const sorted = (xs) => [...xs].sort()
const asKey = (r) => r.key + '\0' + r.count + '\0' + r.test
const posix = (dir) => dir.split('\\').join('/')

/** What every table holds, whatever it was asked: one row per thing, symbol rows consistent, ranked. */
function assertTable(t, tree) {
  assert.ok(Array.isArray(t.rows) && Array.isArray(t.seeds))
  const seen = new Set()
  for (const r of t.rows) {
    for (const f of ['kind', 'mention', 'key']) assert.equal(typeof r[f], 'string', f + ' of ' + JSON.stringify(r))
    assert.equal(typeof r.exists, 'boolean', JSON.stringify(r))
    assert.ok(Array.isArray(r.asks) && Array.isArray(r.defs) && Array.isArray(r.refs) && Number.isInteger(r.files), JSON.stringify(r))
    const id = [r.kind, r.mention, r.key].join('\0')
    assert.equal(seen.has(id), false, 'a second row for ' + id)
    seen.add(id)
    assert.equal(new Set(r.asks).size, r.asks.length, 'asks once each on ' + id)
    if (r.kind === 'symbol') {
      assert.equal(r.key, r.mention)
      assert.equal(r.files, r.refs.length, 'files on ' + r.mention)
      assert.equal(r.exists, r.defs.length > 0 || r.refs.length > 0, 'exists on ' + r.mention)
      for (const d of r.defs) {
        const lines = readFileSync(tree.root + '/' + d.key, 'utf8').split('\n')
        assert.ok(lines[d.line - 1] !== undefined && lines[d.line - 1].includes(r.mention), r.mention + ' is not on ' + d.key + ':' + d.line)
      }
      for (const x of r.refs) assert.equal(x.test, isTestKey(x.key))
    } else {
      assert.deepEqual(r.refs, [], 'refs only on symbol rows')
      assert.equal(r.files, 0, 'files only on symbol rows')
    }
  }
  const firstMissing = t.rows.findIndex((r) => !r.exists)
  if (firstMissing >= 0) assert.ok(t.rows.slice(firstMissing).every((r) => !r.exists), 'a row that exists ranks after a missing one')
  const present = t.rows.filter((r) => r.kind === 'symbol' && r.exists)
  for (let i = 1; i < present.length; i++) assert.ok(present[i - 1].files <= present[i].files, present[i - 1].mention + ' before ' + present[i].mention)
  assert.equal(new Set(t.seeds).size, t.seeds.length, 'a seed once')
  for (const s of t.seeds) assert.deepEqual(keyOf(tree, s), { ok: true, key: s }, 'seed ' + s + ' is a key of the tree')
}

test('every table holds the same invariants, whatever the material', async () => {
  const tree = repo()
  assertTable(await groundTable(tree, { material: [MATERIAL] }), tree)
  assertTable(await groundTable(tree, { material: [MATERIAL], scope: ['src/drop', 'test'] }), tree)
  assertTable(await groundTable(tree, { material: [MATERIAL], scope: ['src/util'], config: { guidance: ['docs/REVIEW.md', 'nope.md'] } }), tree)
  assertTable(await groundTable(tree, { material: [], diff: { base: tree.sha, head: tree.sha } }), tree)
})

test('a symbol row agrees with the refs tool: the same files and counts, narrowed to the same scope', async () => {
  const tree = repo()
  for (const scope of [undefined, ['.'], ['src'], ['src/drop', 'test'], ['src/util']]) {
    const t = await groundTable(tree, { material: [MATERIAL], ...(scope ? { scope } : {}) })
    for (const r of rowsOf(t, 'symbol')) {
      const expected = await refs(tree, { symbol: r.mention }, { scope: scope ?? ['.'] })
      assert.deepEqual(r.refs.map(asKey).sort(), expected.files.map(asKey).sort(), r.mention + ' in ' + JSON.stringify(scope))
    }
  }
})

test('a definition outside the scope is no definition, though a reference inside it still makes the row exist', async () => {
  const t = await groundTable(repo(), { material: [MATERIAL], scope: ['src/drop', 'test'] })
  const stand = row(t, 'symbol', 'ITEM_STAND')
  assert.deepEqual(stand.defs, [])
  assert.deepEqual(sorted(stand.refs.map((r) => r.key)), ['src/drop/stall.ts', 'test/drop.test.ts'])
  assert.equal(stand.exists, true)
  assert.deepEqual(row(t, 'symbol', 'StallOffer').defs, [{ key: 'src/drop/stall.ts', line: 2 }])
})

test('a scope narrower than the tree narrows a shared identifier to the files inside it', async () => {
  const t = await groundTable(repo(), { material: [MATERIAL], scope: ['src/util'] })
  const config = row(t, 'symbol', 'config')
  assert.deepEqual(sorted(config.refs.map((r) => r.key)), ['src/util/a.ts', 'src/util/b.ts', 'src/util/c.ts'])
  assert.equal(config.files, 3)
  assert.deepEqual(config.defs, [])
})

test('asks are the union over every item that named a row, in first-seen order, once each, and never the caller\'s own arrays', async () => {
  const material = deepFreeze([
    { label: 'one', text: '`ITEM_STAND` and `src/drop/stall.ts`', asks: ['a', 'b'] },
    { label: 'two', text: '`ITEM_STAND` `ITEM_STAND` again', asks: ['b', 'c'] },
    { label: 'context', text: '`ITEM_STAND` and `config`' },
    { label: 'empty', text: '`ITEM_STAND` and `config`', asks: [] },
    { label: 'four', text: '`ITEM_STAND`', asks: ['a'] },
  ])
  const tree = repo()
  const t = await groundTable(tree, { material })
  assert.deepEqual(rowsOf(t, 'symbol').filter((r) => r.mention === 'ITEM_STAND').map((r) => r.asks), [['a', 'b', 'c']], 'one row, the union')
  assert.deepEqual(row(t, 'path', 'src/drop/stall.ts').asks, ['a', 'b'])
  assert.deepEqual(row(t, 'symbol', 'config').asks, [], 'context named it: no ask')
  row(t, 'symbol', 'ITEM_STAND').asks.push('z')
  assert.deepEqual(material[0].asks, ['a', 'b'])
  assertTable(await groundTable(tree, { material }), tree)
})

test('mentions merge in material order, whichever item carries asks, and a row is made once however often it is named', async () => {
  const t = await groundTable(repo(), { material: [
    { label: 'context', text: 'First `src/data/items.ts`, then src/drop/draft.ts' },
    { label: 'ask', text: 'Then `src/drop/stall.ts` and src/data/items.ts again', asks: ['ground:one'] },
  ] })
  assert.deepEqual(rowsOf(t, 'path').map((r) => r.key), ['src/data/items.ts', 'src/drop/draft.ts', 'src/drop/stall.ts'])
  assert.deepEqual(row(t, 'path', 'src/data/items.ts').asks, ['ground:one'])
  assert.deepEqual(row(t, 'path', 'src/drop/draft.ts').asks, [])
})

test('a document mentioned in order stays in order, and a path row is made once for every spelling of it', async () => {
  const t = await groundTable(repo(), { material: [{ label: 'm', text: 'REVIEW.md before GOTCHAS.md; src\\drop\\stall.ts, ./src/drop/stall.ts:3 and `src/drop/stall.ts`', asks: ['x'] }] })
  assert.deepEqual(rowsOf(t, 'doc').map((r) => r.mention), ['REVIEW.md', 'GOTCHAS.md'])
  assert.deepEqual(rowsOf(t, 'path').map((r) => [r.mention, r.key, r.exists]), [['src/drop/stall.ts', 'src/drop/stall.ts', true]])
})

test('the inputs are neither changed nor kept: frozen material, scope, config and diff give the same table as fresh ones', async () => {
  const tree = repo()
  const args = () => ({ material: [MATERIAL, { label: 'c', text: 'also `config`' }], scope: ['src', 'test'], diff: { base: tree.sha, head: tree.sha }, config: { guidance: ['docs/REVIEW.md'] } })
  const loose = await groundTable(tree, args())
  const frozen = await groundTable(tree, deepFreeze(args()))
  assert.deepEqual(frozen.rows, loose.rows)
  assert.deepEqual(sorted(frozen.seeds), sorted(loose.seeds))
  assert.deepEqual((await groundTable(tree, args())).rows, loose.rows, 'asking twice is asking once')
})

test('resolving writes nothing to the tree', async () => {
  const tree = repo()
  const before = git(tree.root, 'status', '--porcelain', '-uall')
  await groundTable(tree, { material: [MATERIAL], diff: { base: tree.sha, head: tree.sha }, config: { guidance: ['docs/REVIEW.md'] } })
  assert.equal(git(tree.root, 'status', '--porcelain', '-uall'), before)
})

test('with nothing named the table has no rows and still holds the guidance seeds, and no seed beside a path', async () => {
  const t = await groundTable(repo(), {})
  assert.deepEqual(t.rows, [])
  for (const k of ['CLAUDE.md', 'tools/AGENTS.md', 'docs/REVIEW.md', 'docs/kb/GOTCHAS.md']) assert.ok(t.seeds.includes(k), k)
  assert.equal(t.seeds.includes('src/drop/INDEX.md'), false)
  assert.equal(t.seeds.includes('src/data/data.md'), false)
})

test('a diff that changes nothing adds no change rows and no identifiers', async () => {
  const tree = repo()
  const t = await groundTable(tree, { material: [], diff: { base: tree.sha, head: tree.sha } })
  assert.deepEqual(t.rows, [])
})

// ---- a second repository, with the shapes the first leaves out ----

const FILES2 = {
  'CLAUDE.md': '# root guidance\n',
  'INDEX.md': '# root index\n',
  'top.ts': 'export const top_level = 1\n',
  'pkg/deep/er/AGENTS.md': '# deep agents\n',
  'notes/NOTES.md': '# notes\n',
  'archive/old/NOTES.md': '# old notes\n',
  'src/lib/INDEX.md': '# lib\n',
  'src/lib/lib.md': '# lib module\n',
  'src/lib/mod.ts': 'export const mod_value = 1\n',
  'src/lib/deeper/x.ts': 'export const deep_x = 1\n',
  'src/other/INDEX.md': '# other\n',
  'src/other/other.md': '# other module\n',
  'src/defs.ts': [
    'export function loadAll() {}',
    'export interface Shape { a: number }',
    'export type Alias = string',
    'export enum Color { Red }',
    'let counter = 1',
    'var legacy = 2',
    'export async function fetchAll() {}',
    'export const arrowFn = () => 1',
  ].join('\n') + '\n',
  'src/words.ts': 'export const showOffers = 1\nexport const reshowOffer = 2\nconst showOffer_x = 3\nshowOffer()\n',
  'src/use.ts': 'call(ghost_helper)\n',
  'py/mod.py': 'class PyThing:\n    def method_x(self):\n        return 1\n\ndef py_func(a):\n    return a\n',
  'conf/app.yaml': 'service:\n  ground_known: true\nother: ground_known\n',
  'conf/data.json': '{\n  "nested": {\n    "quest_key": 1\n  },\n  "ref": "quest_key"\n}\n',
}

let world2 = null
function repo2() {
  if (world2) return world2
  const dir = gitRepo(FILES2)
  write(dir, 'pkg/CLAUDE.md', '# untracked guidance\n')
  write(dir, 'pkg/NOTES.md', '# untracked notes\n')
  write(dir, 'vendor/lib/CLAUDE.md', '# nested guidance\n')
  write(dir, 'vendor/lib/NOTES.md', '# nested notes\n')
  git(dir, '-C', 'vendor/lib', 'init', '-q', '.')
  world2 = { root: posix(dir), sha: git(dir, 'rev-parse', 'HEAD') }
  return world2
}
const mat = (text, asks = ['ask']) => ({ label: 'm', text, asks })

test('a path row is what keyOf says of its mention, whatever the mention is', async () => {
  const tree = repo2()
  const text = 'src/lib/deeper/x.ts, src\\lib\\deeper\\x.ts, `top.ts`, `.git/hooks/pre-commit.sample`, notes/ghost.md, pkg/NOTES.md, vendor/lib/NOTES.md, src/nope.ts'
  const t = await groundTable(tree, { material: [mat(text)] })
  assertTable(t, tree)
  const paths = rowsOf(t, 'path')
  assert.deepEqual(sorted(paths.map((r) => r.mention)), sorted(['src/lib/deeper/x.ts', 'top.ts', '.git/hooks/pre-commit.sample', 'notes/ghost.md', 'pkg/NOTES.md', 'vendor/lib/NOTES.md', 'src/nope.ts']), 'one row per file, mention in posix')
  for (const r of paths) {
    const k = keyOf(tree, r.mention)
    assert.deepEqual([r.key, r.exists], k.ok ? [k.key, true] : [r.mention, false], r.mention)
  }
  const byMention = (m) => paths.find((r) => r.mention === m)
  assert.equal(byMention('pkg/NOTES.md').exists, true, 'an untracked file')
  assert.equal(byMention('.git/hooks/pre-commit.sample').exists, false, 'inside .git')
  assert.equal(byMention('vendor/lib/NOTES.md').exists, false, 'inside a nested repository')
  assert.equal(byMention('top.ts').exists, true)
})

test('a bare document name has a row per file of that name anywhere in the tree, untracked included, nested repositories excluded', async () => {
  const t = await groundTable(repo2(), { material: [mat('Read NOTES.md, and MISSING.md too')] })
  const notes = rowsOf(t, 'doc').filter((r) => r.mention === 'NOTES.md')
  assert.deepEqual(sorted(notes.map((r) => r.key)), ['archive/old/NOTES.md', 'notes/NOTES.md', 'pkg/NOTES.md'])
  assert.ok(notes.every((r) => r.exists && r.asks.length === 1 && r.asks[0] === 'ask'))
  const missing = rowsOf(t, 'doc').filter((r) => r.mention === 'MISSING.md')
  assert.equal(missing.length, 1)
  assert.equal(missing[0].exists, false)
  assert.deepEqual(rowsOf(t, 'doc').map((r) => r.mention).filter((m) => m === 'NOTES.md' || m === 'MISSING.md').slice(-1), ['MISSING.md'], 'the missing name ranks after the ones found')
})

test('seeds hold every CLAUDE.md and AGENTS.md at any depth, untracked included, never one inside a nested repository, each once', async () => {
  const tree = repo2()
  const t = await groundTable(tree, { config: { guidance: ['CLAUDE.md', 'notes/NOTES.md', 'missing.md', 'CLAUDE.md'] } })
  for (const k of ['CLAUDE.md', 'pkg/CLAUDE.md', 'pkg/deep/er/AGENTS.md', 'notes/NOTES.md']) assert.ok(t.seeds.includes(k), k)
  for (const k of ['missing.md', 'vendor/lib/CLAUDE.md']) assert.equal(t.seeds.includes(k), false, k)
  assertTable(t, tree)
  assert.deepEqual(t.rows, [])
})

test('beside a resolved path sit its own directory\'s INDEX.md and module .md, and no other directory\'s', async () => {
  const t = await groundTable(repo2(), { material: [mat('`src/lib/mod.ts` and `top.ts`')] })
  for (const k of ['src/lib/INDEX.md', 'src/lib/lib.md', 'INDEX.md']) assert.ok(t.seeds.includes(k), k)
  for (const k of ['src/other/INDEX.md', 'src/other/other.md']) assert.equal(t.seeds.includes(k), false, k)
  const deep = await groundTable(repo2(), { material: [mat('`src/lib/deeper/x.ts`')] })
  assert.equal(deep.seeds.includes('src/lib/INDEX.md'), false, 'the file sits in src/lib/deeper, which has none')
  assert.equal(deep.seeds.includes('src/lib/lib.md'), false)
})

test('a path that does not resolve seeds nothing beside it', async () => {
  const t = await groundTable(repo2(), { material: [mat('`src/other/missing.ts`')] })
  assert.equal(rowsOf(t, 'path')[0].exists, false)
  assert.equal(t.seeds.includes('src/other/INDEX.md'), false)
  assert.equal(t.seeds.includes('src/other/other.md'), false)
})

test('JS and TS definitions: function, interface, type, enum, let, var, async function and a const arrow, each at its line', async () => {
  const tree = repo2()
  const t = await groundTable(tree, { material: [mat('`loadAll` `Shape` `Alias` `Color` `counter` `legacy` `fetchAll` `arrowFn`')] })
  assertTable(t, tree)
  const at = (m) => row(t, 'symbol', m).defs
  assert.deepEqual(at('loadAll'), [{ key: 'src/defs.ts', line: 1 }])
  assert.deepEqual(at('Shape'), [{ key: 'src/defs.ts', line: 2 }])
  assert.deepEqual(at('Alias'), [{ key: 'src/defs.ts', line: 3 }])
  assert.deepEqual(at('Color'), [{ key: 'src/defs.ts', line: 4 }])
  assert.deepEqual(at('counter'), [{ key: 'src/defs.ts', line: 5 }])
  assert.deepEqual(at('legacy'), [{ key: 'src/defs.ts', line: 6 }])
  assert.deepEqual(at('fetchAll'), [{ key: 'src/defs.ts', line: 7 }])
  assert.deepEqual(at('arrowFn'), [{ key: 'src/defs.ts', line: 8 }])
})

test('Python definitions: a class, a method and a function, each at its line', async () => {
  const t = await groundTable(repo2(), { material: [mat('`PyThing` `method_x` `py_func`')] })
  assert.deepEqual(row(t, 'symbol', 'PyThing').defs, [{ key: 'py/mod.py', line: 1 }])
  assert.deepEqual(row(t, 'symbol', 'method_x').defs, [{ key: 'py/mod.py', line: 2 }])
  assert.deepEqual(row(t, 'symbol', 'py_func').defs, [{ key: 'py/mod.py', line: 5 }])
})

test('a key in YAML or JSON is a definition, a value of the same name is only a reference', async () => {
  const t = await groundTable(repo2(), { material: [mat('`ground_known` and `quest_key`')] })
  const yaml = row(t, 'symbol', 'ground_known')
  assert.deepEqual(yaml.defs, [{ key: 'conf/app.yaml', line: 2 }])
  assert.deepEqual(yaml.refs.map((r) => r.key), ['conf/app.yaml'])
  const json = row(t, 'symbol', 'quest_key')
  assert.deepEqual(json.defs, [{ key: 'conf/data.json', line: 3 }])
  assert.deepEqual(json.refs.map((r) => r.key), ['conf/data.json'])
})

test('a use is not a definition, and a reference is the whole word: showOffers, reshowOffer and showOffer_x are other words', async () => {
  const t = await groundTable(repo2(), { material: [mat('`ghost_helper` and `showOffer`')] })
  const ghost = row(t, 'symbol', 'ghost_helper')
  assert.deepEqual([ghost.defs, ghost.files, ghost.exists, ghost.refs.map((r) => r.key)], [[], 1, true, ['src/use.ts']])
  const offer = row(t, 'symbol', 'showOffer')
  assert.deepEqual([offer.defs, offer.files, offer.exists, offer.refs.map((r) => r.key)], [[], 1, true, ['src/words.ts']])
})

// ---- a diff over a repository whose head differs from its base ----

test("a diff names only what its added and removed lines hold: not its context, not a path's own words", async () => {
  const dir = gitRepo({
    'src/long_file_name.ts': 'const x = 1\nconst y = 3\nexport const KEEP_ME = 2\nexport const GONE_SYMBOL = 1\n',
    'src/other.ts': 'export const OTHER = 1\n',
  })
  const base = git(dir, 'rev-parse', 'HEAD')
  write(dir, 'src/long_file_name.ts', 'const x = 2\nconst y = 3\nexport const KEEP_ME = 2\n')
  write(dir, 'src/added.ts', 'export const ADDED_THING = 1\n')
  const head = commit(dir)
  const tree = { root: posix(dir), sha: head }
  const t = await groundTable(tree, { material: [], diff: { base, head } })
  assertTable(t, tree)
  assert.deepEqual(rowsOf(t, 'change').map((r) => [r.key, r.exists, r.asks]).sort(), [['src/added.ts', true, []], ['src/long_file_name.ts', true, []]])
  assert.deepEqual(row(t, 'symbol', 'ADDED_THING').defs, [{ key: 'src/added.ts', line: 1 }])
  assert.deepEqual([row(t, 'symbol', 'GONE_SYMBOL').exists, row(t, 'symbol', 'GONE_SYMBOL').asks], [false, []])
  const named = rowsOf(t, 'symbol').map((r) => r.mention)
  for (const m of ['KEEP_ME', 'OTHER', 'long_file_name', 'file_name']) assert.equal(named.includes(m), false, m + ' is in no added or removed line')
  assert.ok(t.rows.findIndex((r) => r.mention === 'GONE_SYMBOL') > t.rows.findIndex((r) => r.mention === 'ADDED_THING'), 'what is gone ranks after what is there')
})

test('what material names and the diff names too is one row carrying the material\'s asks', async () => {
  const dir = gitRepo(FILES)
  const base = git(dir, 'rev-parse', 'HEAD')
  write(dir, 'src/data/items.ts', FILES['src/data/items.ts'] + 'export const NEW_THING = 1\n')
  const head = commit(dir)
  const tree = { root: posix(dir), sha: head }
  const t = await groundTable(tree, { material: [mat('`NEW_THING` in `src/data/items.ts`', ['ground:one'])], diff: { base, head } })
  assertTable(t, tree)
  assert.deepEqual(rowsOf(t, 'symbol').filter((r) => r.mention === 'NEW_THING').map((r) => r.asks), [['ground:one']])
  assert.ok(t.rows.filter((r) => r.key === 'src/data/items.ts').some((r) => r.asks.includes('ground:one')), 'the file the material named carries its ask')
  assert.ok(t.rows.filter((r) => r.kind === 'change').every((r) => r.asks.every((a) => a === 'ground:one')), 'a change row holds only asks that named it')
})
