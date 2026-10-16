// test/citations-search.test.mjs — a search's findings as its readers read them: each ask's end,
// hits, dismissals and what it never reached, then the lines the hits point at, read once from the
// tree the search ran on.
//
// Design: docs/DESIGN.md#what-a-probe-costs.

import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { hitExcerpts, searchExcerpts } from '../lib/citations.mjs'
import { fnv1a } from '../lib/plan-digest.mjs'
import { canonicalUrl } from '../lib/search/query.mjs'

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'agentics-search-excerpts-')).split('\\').join('/')
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content, 'utf8')
  }
  return { root, sha: 'f'.repeat(40) }
}
const numbered = (n, tag) => Array.from({ length: n }, (_, i) => tag + (i + 1)).join('\n')
const done = (extra = {}) => ({ end: 'done', label: 'observed', why: 'every key in scope was read or dismissed', declared: 'answered', answer: '', hits: [], dismissed: [], unreached: [], ...extra })

function result(t, asks) {
  return { name: 'locate', status: 'returned', cause: '', tree: t, ground: { rows: [], seeds: [] }, asks, sessions: [], entries_n: 0, kinds: {}, coverage: { declared: [], incomplete: [], unreached: [], failed_channels: [] } }
}

test("searchExcerpts renders each ask's end and label, its hits with notes, its dismissals and what it never reached", () => {
  const t = tree({ 'src/store.ts': numbered(40, 'store') })
  const r = result(t, {
    'ground:intro': done({
      hits: [{ key: 'src/store.ts', line: 12, note: 'the store is created here', turn: 1 }],
      dismissed: [
        { key: 'src/old.ts', why: 'dead code', turn: 2, read_to_end: true },
        { key: 'src/big.ts', why: 'generated', turn: 2, read_to_end: false },
        { glob: 'src/**/*.snap', why: 'snapshots', turn: 2, read_to_end: false },
        { call: 4, why: 'every match is a fixture', turn: 2, read_to_end: false },
      ],
    }),
    'ground:api': { ...done(), end: 'no_progress', label: 'observed', why: 'its state after turn 3 equals its state after turn 2', declared: '', unreached: [{ kind: 'ground', key: 'src/api.ts', detail: 'path src/api.ts' }, { kind: 'overflow', key: 'call:2', detail: 'page 2 of 3' }] },
  })
  const { text } = searchExcerpts(r)
  for (const line of [
    '=== locate:ground:intro — done (observed): every key in scope was read or dismissed',
    'HITS:\n  src/store.ts:12 — the store is created here',
    '  src/old.ts — dead code (read to the end)',
    '  src/big.ts — generated (not read to its end)',
    '  glob src/**/*.snap — snapshots',
    '  call 4 — every match is a fixture',
    '=== locate:ground:api — no_progress (observed): its state after turn 3 equals its state after turn 2',
    'HITS:\n  (none)',
    'NOT REACHED:\n  ground src/api.ts — path src/api.ts\n  overflow call:2 — page 2 of 3',
  ]) assert.ok(text.includes(line), line)
  assert.ok(text.indexOf('=== locate:ground:intro') < text.indexOf('=== locate:ground:api'))
})

test('the refusals standing against an ask are rendered under it, and those naming no ask once, unless asks or kind narrow', () => {
  const refusals = [
    { turn: 2, class: 'unobserved', item: { kind: 'hit', path: 'src/b.ts', line: 9, note: 'n' }, asks: ['ground:intro'] },
    { turn: 3, class: 'unknown_ask', item: { kind: 'hit', path: 'src/z.ts', line: 1, note: 'n' }, asks: [] },
  ]
  const r = { ...result(tree({}), { 'ground:intro': done(), 'ground:api': done() }), refusals }
  const { text } = searchExcerpts(r)
  assert.ok(text.includes('REFUSED:\n  turn 2 hit src/b.ts:9 — unobserved: no call of this search showed it under its asks'), text)
  assert.ok(text.indexOf('REFUSED:') > text.indexOf('=== locate:ground:intro') && text.indexOf('REFUSED:') < text.indexOf('=== locate:ground:api'), 'under its own ask')
  assert.ok(text.includes('turn 3 hit src/z.ts:1 — unknown_ask: it names an ask this search does not have'), 'an item naming no ask')
  const narrowed = searchExcerpts(r, { asks: ['ground:api'] }).text
  assert.equal(narrowed.includes('src/b.ts'), false, 'a refusal against another ask')
  assert.equal(narrowed.includes('src/z.ts'), false, 'narrowed to some asks')
  assert.equal(searchExcerpts(result(tree({}), { 'ground:api': done() })).text.includes('REFUSED'), false, 'a search with no standing refusal says nothing')
})

test('an ask with no end reads as still open', () => {
  const r = result(tree({}), { guidance: { ...done(), end: null, label: '', why: '' } })
  assert.ok(searchExcerpts(r).text.includes('=== locate:guidance — still open'))
})

test('the lines the hits point at are read once from tree.root, overlapping windows merged', () => {
  const t = tree({ 'src/store.ts': numbered(60, 'store'), 'src/view.ts': numbered(30, 'view') })
  const r = result(t, {
    'ground:a': done({ hits: [{ key: 'src/store.ts', line: 20, note: 'a', turn: 1 }, { key: 'src/view.ts', line: 5, note: 'b', turn: 1 }] }),
    'ground:b': done({ hits: [{ key: 'src/store.ts', line: 24, note: 'c', turn: 2 }] }),
  })
  const out = searchExcerpts(r)
  assert.deepEqual(out.counts, { locations: 3, files: 2, excerpts: 2, unresolved: 0 })
  assert.ok(out.text.includes('EXCERPTS — every hit above with a line, read once by a script'))
  assert.ok(out.text.includes('store20') && out.text.includes('store24') && out.text.includes('view5'))
  assert.equal(out.text.split('--- src/store.ts').length - 1, 1, 'one block per file')
})

test('asks narrows to the named asks, and kind to asks whose key is the kind or starts with kind:', () => {
  const t = tree({ 'a.ts': numbered(5, 'a') })
  const hit = (n) => [{ key: 'a.ts', line: n, note: 'n' + n, turn: 1 }]
  const r = result(t, {
    guidance: done({ hits: hit(1) }), 'ground:intro': done({ hits: hit(2) }), 'ground:api': done({ hits: hit(3) }), groundwork: done({ hits: hit(4) }),
  })
  const titles = (text) => [...text.matchAll(/^=== locate:(\S+) —/gm)].map((m) => m[1])
  assert.deepEqual(titles(searchExcerpts(r, { kind: 'ground' }).text), ['ground:intro', 'ground:api'])
  assert.deepEqual(titles(searchExcerpts(r, { kind: 'guidance' }).text), ['guidance'])
  assert.deepEqual(titles(searchExcerpts(r, { asks: ['groundwork', 'guidance'] }).text), ['guidance', 'groundwork'])
  assert.deepEqual(searchExcerpts(r, { kind: 'ground' }).counts.locations, 2, 'only the selected asks are excerpted')
  assert.equal(searchExcerpts(r, { kind: 'nothing' }).text, '(no ask of this search was selected)')
})

test('a hit with no line, a commit or a url, is listed and not excerpted', () => {
  const sha = 'c'.repeat(40)
  const r = result(tree({}), {
    history: done({ hits: [{ key: sha, line: 0, note: 'adds the stall', turn: 1 }] }),
    'research:state': done({ hits: [{ key: 'https://github.com/pmndrs/zustand', line: 0, note: 'the library', turn: 1 }] }),
  })
  const out = searchExcerpts(r)
  assert.ok(out.text.includes('  ' + sha + ' — adds the stall'))
  assert.ok(out.text.includes('  https://github.com/pmndrs/zustand — the library'))
  assert.equal(out.text.includes('EXCERPTS'), false)
  assert.deepEqual(out.counts, { locations: 0, files: 0, excerpts: 0, unresolved: 0 })
})

test('a hit whose file is gone or whose line is past its end is unresolved, not dropped', () => {
  const t = tree({ 'src/short.ts': numbered(3, 's') })
  const r = result(t, { 'ground:a': done({ hits: [{ key: 'src/gone.ts', line: 4, note: 'x', turn: 1 }, { key: 'src/short.ts', line: 9, note: 'y', turn: 1 }] }) })
  const out = searchExcerpts(r)
  assert.deepEqual(out.unresolved.map((u) => [u.path, u.line, u.why]), [['src/gone.ts', 4, 'missing'], ['src/short.ts', 9, 'out_of_range']])
  assert.equal(out.counts.unresolved, 2)
  assert.ok(out.text.includes('NOT EXCERPTED'))
})

test("tree.root is read, not the process's working directory", () => {
  const t = tree({ '.claude/worktrees/search-e-12345678/src/a.ts': numbered(10, 'pinned') })
  const pinned = { root: t.root + '/.claude/worktrees/search-e-12345678', sha: t.sha }
  const out = searchExcerpts(result(pinned, { 'ground:a': done({ hits: [{ key: 'src/a.ts', line: 5, note: 'n', turn: 1 }] }) }))
  assert.ok(out.text.includes('pinned5'))
  assert.equal(out.counts.unresolved, 0)
})

test('excerpts say what was looked for', () => {
  const looked = [
    { seq: 3, tool: 'grep', what: 'createStore', where: ['src/', 'lib/'], total: 4, pages: 1, pages_seen: 1 },
    { seq: 5, tool: 'read', what: 'src/store.ts:1-40', where: ['src/store.ts'], total: 40, pages: 1, pages_seen: 1 },
  ]
  const text = searchExcerpts(result(tree({}), { 'ground:a': done({ looked }) })).text
  assert.ok(text.includes('LOOKED:\n  call 3 grep createStore in src/, lib/ → 4\n  call 5 read src/store.ts:1-40 in src/store.ts → 40'), text)
})

test('excerpts say when nothing was looked for', () => {
  const text = searchExcerpts(result(tree({}), { 'ground:a': done({ looked: [] }) })).text
  assert.ok(text.includes('LOOKED:\n  (nothing looked for)'), text)
})

test('a hit under a ruled absence is marked', () => {
  const a = done({ label: 'ruled', answer: 'absent', why: 'no store exists', hits: [{ key: 'src/x.ts', line: 0, note: 'a stub', turn: 1 }] })
  const text = searchExcerpts(result(tree({}), { 'ground:a': a })).text
  assert.ok(text.includes('  src/x.ts — a stub (ruled not an answer)'), text)
  const answered = searchExcerpts(result(tree({}), { 'ground:a': { ...a, answer: 'answered' } })).text
  assert.equal(answered.includes('(ruled not an answer)'), false)
})

test('an empty dismissal is marked', () => {
  const a = done({ dismissed: [{ glob: 'docs/**', why: 'prose', turn: 2, read_to_end: false, closes: 0 }, { glob: 'gen/**', why: 'generated', turn: 2, read_to_end: false, closes: 3 }] })
  const text = searchExcerpts(result(tree({}), { 'ground:a': a })).text
  assert.ok(text.includes('  glob docs/** — prose (closed nothing)'), text)
  assert.ok(text.includes('  glob gen/** — generated\n'), text)
})

test('owed files render by directory', () => {
  const a = done({ unreached: [{ kind: 'files', key: 'src/data/', detail: '7 not covered' }] })
  const text = searchExcerpts(result(tree({}), { 'ground:a': a })).text
  assert.ok(text.includes('NOT REACHED:\n  files src/data/ — 7 not covered'), text)
})

test('the head names the ruled answer', () => {
  const a = done({ label: 'ruled', answer: 'answered', why: 'the store is created in one place' })
  const text = searchExcerpts(result(tree({}), { 'ground:a': a })).text
  assert.ok(text.includes('=== locate:ground:a — done (ruled): answered: the store is created in one place'), text)
})

// ------------------------------------------------------------------ hitExcerpts: a search's hits as a reader reads them

/** A git repo with one commit of `files`; its tree and the commit's sha. */
function committed(files, subject) {
  const t = tree(files)
  const git = (...args) => spawnSync('git', ['-C', t.root, ...args], { encoding: 'utf8' })
  git('init', '-q')
  git('add', '-A')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', subject)
  return { tree: t, sha: git('rev-parse', 'HEAD').stdout.trim() }
}
const found = (t, hits, over = {}) => ({ name: 'locate', status: 'done', why: '', summary: 'found it', hits, calls: [], cost: 0, tree: t, pages: join(t.root, 'pages'), sessions: [], ...over })

test('a path hit is shown with the lines around it', () => {
  const t = tree({ 'src/a.mjs': numbered(30, 'line') })
  const out = hitExcerpts(found(t, [{ path: 'src/a.mjs', line: 15, note: 'the adder', label: 'ground' }]))
  assert.ok(out.text.startsWith('=== locate — done\nfound it'), out.text)
  assert.ok(out.text.includes('- src/a.mjs:15 — the adder [ground]'))
  assert.ok(out.text.includes('     5\tline5'))
  assert.ok(out.text.includes('    15\tline15'))
  assert.ok(out.text.includes('    25\tline25'))
  assert.ok(!out.text.includes('\tline26'))
  assert.deepEqual(out.counts, { hits: 1, unresolved: 0 })
})

test('a hit on a missing file or line is marked, not read', () => {
  const t = tree({ 'src/a.mjs': numbered(3, 'line') })
  const out = hitExcerpts(found(t, [{ path: 'src/gone.mjs', line: 1, note: 'gone' }, { path: 'src/a.mjs', line: 9, note: 'past' }]))
  assert.deepEqual(out.counts, { hits: 2, unresolved: 2 })
  assert.deepEqual(out.unresolved.map((u) => [u.path, u.line, u.why]), [['src/gone.mjs', 1, 'missing'], ['src/a.mjs', 9, 'out_of_range']])
  assert.ok(out.text.includes('(out_of_range: '), out.text)
  assert.ok(out.text.includes('(missing: '), out.text)
  assert.ok(!out.text.includes('\tline'))
})

test('a commit hit is shown with its subject', () => {
  const { tree: t, sha } = committed({ 'a.txt': 'a' }, 'add the adder')
  const out = hitExcerpts(found(t, [{ commit: sha, note: 'the change' }]))
  assert.ok(out.text.includes('- commit ' + sha + ' — the change\n  add the adder'), out.text)
})

test("a url hit is shown with its page's lines", () => {
  const t = tree({})
  const url = 'https://example.com/docs'
  const key = canonicalUrl(url)
  const pages = join(t.root, 'pages')
  mkdirSync(pages, { recursive: true })
  writeFileSync(join(pages, fnv1a(key) + '.json'), JSON.stringify({ key, status: 200, bytes: 1, lines: numbered(40, 'doc').split('\n') }))
  const out = hitExcerpts(found(t, [{ url, line: 20, note: 'the docs' }]))
  assert.ok(out.text.includes('- ' + url + ':20 — the docs'))
  assert.ok(out.text.includes('    10\tdoc10'))
  assert.ok(out.text.includes('    30\tdoc30'))
  assert.ok(!out.text.includes('\tdoc31'))
  assert.ok(!out.text.includes('\tdoc9\n'))
})

test('excerpts narrowed to a label hold only its hits', () => {
  const t = tree({ 'src/a.mjs': numbered(5, 'line') })
  const out = hitExcerpts(found(t, [{ path: 'src/a.mjs', line: 1, note: 'one', label: 'ground' }, { path: 'src/a.mjs', line: 2, note: 'two', label: 'guidance' }]), { label: 'guidance' })
  assert.ok(out.text.includes('src/a.mjs:2 — two'))
  assert.ok(!out.text.includes('src/a.mjs:1 — one'))
  assert.equal(out.counts.hits, 1)
})
