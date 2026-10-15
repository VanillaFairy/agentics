// test/search-tree-of.test.mjs — the tree a standalone program searches: its root, absolute and
// posix, at the HEAD it has when the program starts.
//
// Design: docs/DESIGN.md#searches.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'

import { treeOf } from '../lib/search/pin.mjs'
import { seededRepo } from './harness/seeded-repo.mjs'

const headOf = (repo) => execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim()

test("treeOf is the root, absolute with posix separators, at the root's HEAD", (t) => {
  const repo = seededRepo('agentics-tree-of-', { message: 'init', files: { 'a.txt': 'a\n' }, autocrlf: false })
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const tree = treeOf(repo)
  assert.equal(tree.root, repo.split('\\').join('/'))
  assert.ok(!tree.root.includes('\\'))
  assert.equal(tree.sha, headOf(repo))
  assert.match(tree.sha, /^[0-9a-f]{40}$/)
})
