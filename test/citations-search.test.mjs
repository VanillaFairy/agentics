// test/citations-search.test.mjs — a search's findings as its readers read them: each ask's end,
// hits, dismissals and what it never reached, then the lines the hits point at, read once from the
// tree the search ran on.
//
// Design: docs/DESIGN.md#what-a-probe-costs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { searchExcerpts } from '../lib/citations.mjs'

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
const done = (extra = {}) => ({ end: 'done', label: 'observed', why: 'every key in scope was read or dismissed', declared: 'answered', absence: '', hits: [], dismissed: [], unreached: [], ...extra })

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
