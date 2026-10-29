// test/evidence-anchors-content.test.mjs — the content rung in front of the diff: a span decided by
// its text alone, without git, and every case that must still reach the diff.
//
// Design: docs/DESIGN.md#the-drift-ladder.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renameSync } from 'node:fs'
import { join } from 'node:path'

import { commit, gitRepo, lines, record, span, stateOf, text, write } from './harness/evidence-fixture.mjs'

/** Hide the repository's history, so a check that still needed git could no longer read `at`. */
const withoutGit = (repo) => renameSync(join(repo, '.git'), join(repo, '.git-hidden'))

test('once its blob is cached, a span shifted by an edit above stands without git', () => {
  const repo = gitRepo({ 'src/a.js': text(lines(30)) })
  const id = record(repo, span('src/a.js', 10, 14))
  assert.equal(stateOf(repo, id).state, 'standing', 'the first check reads the blob and caches it')
  write(repo, 'src/a.js', text(['added 1', 'added 2', ...lines(30)]))
  withoutGit(repo)
  assert.equal(stateOf(repo, id).state, 'standing')
})

test('a one-line span whose line is gone is suspect, though the same line stands elsewhere', () => {
  const body = ['a', '}', 'b', 'c', '}', 'd']
  const repo = gitRepo({ 'src/a.js': text(body) })
  const id = record(repo, span('src/a.js', 2, 2))
  write(repo, 'src/a.js', text(body.filter((_, i) => i !== 1)))
  commit(repo)
  assert.equal(stateOf(repo, id).state, 'suspect')
})

test('a block copied elsewhere and then edited where it was is suspect, not standing on the copy', () => {
  const block = ['function add(a, b) {', '  return a + b', '}']
  const before = [...lines(5), ...block, ...lines(5, 'tail')]
  const repo = gitRepo({ 'src/a.js': text(before) })
  const id = record(repo, span('src/a.js', 6, 8))
  write(repo, 'src/a.js', text([...lines(5), 'function add(a, b) {', '  return a - b', '}', ...lines(5, 'tail'), '', ...block]))
  commit(repo)
  assert.equal(stateOf(repo, id).state, 'suspect')
})

test('a check repeated in one process sees a second edit of a file already dirty, and the file put back', () => {
  const repo = gitRepo({ 'src/a.js': text(lines(30)) })
  const id = record(repo, span('src/a.js', 10, 14))
  write(repo, 'src/a.js', text([...lines(30), 'appended']))
  assert.equal(stateOf(repo, id).state, 'standing', 'an edit below the span: dirty, still standing')
  const edited = lines(30)
  edited[11] = 'changed'
  write(repo, 'src/a.js', text([...edited, 'appended', 'and more']))
  assert.equal(stateOf(repo, id).state, 'suspect', 'the same file, dirty before and after, edited inside the span')
  write(repo, 'src/a.js', text(lines(30)))
  assert.equal(stateOf(repo, id).state, 'standing', 'put back')
})
