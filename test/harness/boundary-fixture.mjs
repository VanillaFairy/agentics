// test/harness/boundary-fixture.mjs — the repository, tree rows and commits the boundary, landing
// and migration tests share.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

// The fixtures' own suites run `node --test`; a grandchild that sees this runner's marker runs
// nothing and exits 0, which would make every measurement a pass. It is cleared here so that every
// file building these fixtures is covered by importing them.
delete process.env.NODE_TEST_CONTEXT

export const STAMP = '20260925-120000'
export const COMMANDS = {
  suite: 'node --test --test-reporter=spec', test_one: 'node --test --test-reporter=spec {file}',
  absent: { build: true, typecheck: true },
}

export const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + r.stderr)
  return r.stdout.trim()
}

export function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'agentics-boundary-'))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 't@example.com')
  git(dir, 'config', 'user.name', 'T')
  mkdirSync(join(dir, 'src'))
  mkdirSync(join(dir, 'test'))
  writeFileSync(join(dir, '.gitignore'), '.claude/\n')
  writeFileSync(join(dir, 'src', 'add.mjs'), 'export const add = (a, b) => a + b\n')
  writeFileSync(join(dir, 'test', 'add.test.mjs'), "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add } from '../src/add.mjs'\ntest('adds', () => assert.equal(add(1, 2), 3))\n")
  writeFileSync(join(dir, 'README.md'), 'hello\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'base')
  return dir
}

export const leaf = (id, extra = {}) => ({
  id, kind: 'leaf', title: 'do ' + id, rigor: 'tdd', decisions: ['D1'],
  acceptance: [{ text: id + ' works', check: 'node --test', decisions: ['D1'] }], ...extra,
})
export const root = (extra = {}) => ({ id: '.', kind: 'composite', title: 'the change', defines: [{ id: 'D1', text: 'do it' }], ...extra })

export function commitIn(wt, files, subject) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(wt, path, '..'), { recursive: true })
    writeFileSync(join(wt, path), text)
  }
  git(wt, 'add', '-A')
  git(wt, 'commit', '-q', '-m', subject)
  return git(wt, 'rev-parse', 'HEAD')
}

export const A_TEST = "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { a } from '../src/a.mjs'\ntest('a is 1', () => assert.equal(a(), 1))\n"
