// test/citations-search.test.mjs — a search's hits as its readers read them: each hit with its note,
// then the lines it points at, read once from the tree the search ran on.
//
// Design: docs/DESIGN.md#what-a-probe-costs.

import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { hitExcerpts } from '../lib/citations.mjs'
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
