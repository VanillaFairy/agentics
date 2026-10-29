// test/fast/brief-guidance.test.mjs — pins the repository's guidance a dispatch's prompt carries: its
// CLAUDE.md files from the root down to each directory the dispatch touches, then the files the
// project's config names under `guidance`.
//
// Design: docs/DESIGN.md#briefs-and-returns.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { guidanceOf } from '../../lib/brief.mjs'

/** A directory holding `files` (repo-relative path → text). */
function tree(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'agentics-guidance-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

const block = (path, text) => '### ' + path + '\n\n' + text
const doc = (...blocks) => ['## Repository guidance', ...blocks].join('\n\n')

test('the root CLAUDE.md is the guidance by default', (t) => {
  const root = tree(t, { 'CLAUDE.md': 'root rules\n', 'src/CLAUDE.md': 'src rules\n' })
  assert.equal(guidanceOf(root), doc(block('CLAUDE.md', 'root rules')))
})

test('a directory takes every CLAUDE.md from the root down to it, root first', (t) => {
  const root = tree(t, { 'CLAUDE.md': 'r', 'src/CLAUDE.md': 's', 'src/a/CLAUDE.md': 'a', 'src/a/deep/CLAUDE.md': 'd' })
  assert.equal(guidanceOf(root, { dirs: ['src/a'] }), doc(block('CLAUDE.md', 'r'), block('src/CLAUDE.md', 's'), block('src/a/CLAUDE.md', 'a')))
})

test('a directory without a CLAUDE.md of its own adds nothing', (t) => {
  const root = tree(t, { 'CLAUDE.md': 'r', 'src/a/CLAUDE.md': 'a' })
  assert.equal(guidanceOf(root, { dirs: ['src/a'] }), doc(block('CLAUDE.md', 'r'), block('src/a/CLAUDE.md', 'a')))
})

test('two directories sharing a parent show each file once', (t) => {
  const root = tree(t, { 'CLAUDE.md': 'r', 'src/CLAUDE.md': 's', 'src/a/CLAUDE.md': 'a', 'src/b/CLAUDE.md': 'b' })
  assert.equal(guidanceOf(root, { dirs: ['src/a', 'src/b'] }),
    doc(block('CLAUDE.md', 'r'), block('src/CLAUDE.md', 's'), block('src/a/CLAUDE.md', 'a'), block('src/b/CLAUDE.md', 'b')))
})

test('configured guidance follows the CLAUDE.md files, in its order', (t) => {
  const root = tree(t, { 'CLAUDE.md': 'r', 'docs/style.md': 'style', 'docs/arch.md': 'arch' })
  const config = { guidance: ['docs/style.md', 'docs/arch.md'] }
  assert.equal(guidanceOf(root, { config }), doc(block('CLAUDE.md', 'r'), block('docs/style.md', 'style'), block('docs/arch.md', 'arch')))
})

test('a configured file that is missing shows as not found', (t) => {
  const root = tree(t, { 'CLAUDE.md': 'r' })
  assert.equal(guidanceOf(root, { config: { guidance: ['docs/gone.md'] } }), doc(block('CLAUDE.md', 'r'), block('docs/gone.md', '(not found)')))
})

test('a file is shown once even when it is also configured', (t) => {
  const root = tree(t, { 'CLAUDE.md': 'r', 'docs/style.md': 'style' })
  const config = { guidance: ['CLAUDE.md', 'docs/style.md', 'docs/style.md'] }
  assert.equal(guidanceOf(root, { config }), doc(block('CLAUDE.md', 'r'), block('docs/style.md', 'style')))
})

test('nothing to show is the empty string', (t) => {
  const root = tree(t, { 'src/a.js': '' })
  assert.equal(guidanceOf(root, { dirs: ['src'] }), '')
})

test('a directory written with backslashes reads as forward slashes', (t) => {
  const root = tree(t, { 'CLAUDE.md': 'r', 'src/a/CLAUDE.md': 'a' })
  assert.equal(guidanceOf(root, { dirs: ['src\\a'] }), guidanceOf(root, { dirs: ['src/a'] }))
  assert.equal(guidanceOf(root, { config: { guidance: ['src\\a\\CLAUDE.md'] } }), guidanceOf(root, { dirs: ['src/a'] }))
})

test('the directory "." is the root', (t) => {
  const root = tree(t, { 'CLAUDE.md': 'r', 'src/CLAUDE.md': 's' })
  assert.equal(guidanceOf(root, { dirs: ['.'] }), doc(block('CLAUDE.md', 'r')))
  assert.equal(guidanceOf(root, { dirs: ['./src/'] }), doc(block('CLAUDE.md', 'r'), block('src/CLAUDE.md', 's')))
})

test('a file with CRLF endings reads as LF', (t) => {
  const root = tree(t, { 'CLAUDE.md': 'one\r\ntwo\r\n' })
  assert.equal(guidanceOf(root), doc(block('CLAUDE.md', 'one\ntwo')))
})

/** A repository at `<base>/repo` with `files`, and the folder around it holding `outside`. */
function nested(t, files, outside) {
  const base = tree(t, outside)
  const root = join(base, 'repo')
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return { base, root }
}

test('a directory outside the repository root is dropped', (t) => {
  const { root } = nested(t, { 'CLAUDE.md': 'r', 'src/CLAUDE.md': 's' }, { 'CLAUDE.md': 'secret', 'other/CLAUDE.md': 'secret too' })
  const shown = guidanceOf(root, { dirs: ['src', '../other', 'src/../..', '..'] })
  assert.equal(shown, doc(block('CLAUDE.md', 'r'), block('src/CLAUDE.md', 's')))
})

test('a configured file outside the repository root is dropped', (t) => {
  const { base, root } = nested(t, { 'CLAUDE.md': 'r' }, { 'CLAUDE.md': 'secret', 'notes.md': 'secret too' })
  const config = { guidance: ['../CLAUDE.md', 'docs/../../notes.md', join(base, 'notes.md'), '/notes.md'] }
  assert.equal(guidanceOf(root, { config }), doc(block('CLAUDE.md', 'r')))
})

test('a path inside the root that passes through .. reads as its one spelling', (t) => {
  const root = tree(t, { 'CLAUDE.md': 'r', 'src/CLAUDE.md': 's', 'docs/style.md': 'style' })
  assert.equal(guidanceOf(root, { dirs: ['docs/../src'] }), guidanceOf(root, { dirs: ['src'] }))
  assert.equal(guidanceOf(root, { config: { guidance: ['src/../docs/style.md'] } }), doc(block('CLAUDE.md', 'r'), block('docs/style.md', 'style')))
})

test('a configured path is shown once in any spelling', (t) => {
  const root = tree(t, { 'CLAUDE.md': 'r', 'docs/style.md': 'style' })
  const config = { guidance: ['./CLAUDE.md', 'docs//style.md', './docs/style.md'] }
  assert.equal(guidanceOf(root, { config }), doc(block('CLAUDE.md', 'r'), block('docs/style.md', 'style')))
})

test('a configured file that cannot be read shows as unreadable', (t) => {
  const root = tree(t, { 'CLAUDE.md': 'r', 'docs/style.md': 'style' })
  assert.equal(guidanceOf(root, { config: { guidance: ['docs'] } }), doc(block('CLAUDE.md', 'r'), block('docs', '(unreadable)')))
})

test('a directory that climbs out of the root is dropped even where its remainder exists inside', (t) => {
  const { root } = nested(t, { 'CLAUDE.md': 'r', 'repo/CLAUDE.md': 'inner' }, {})
  assert.equal(guidanceOf(root, { dirs: ['.', '../repo'] }), doc(block('CLAUDE.md', 'r')))
})

test('a guidance file is read through the one text port: its byte-order mark and CRLF line ends are gone', (t) => {
  const root = tree(t, { 'CLAUDE.md': '\uFEFFone\r\ntwo\r\n' })
  assert.equal(guidanceOf(root), doc(block('CLAUDE.md', 'one\ntwo')))
})
