// test/store.test.mjs — where agentics keeps its state: `.agentics/` in the main checkout, the
// project-wide `.state/`, one directory per effort and per folder, the segment rule, and the
// project settings file.
//
// Design: docs/DESIGN.md#storage.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'

import { append, readLog } from '../lib/ledger.mjs'
import {
  AGENTICS_DIR, CONFIG_FILE, EVIDENCE_RENDER, ROOT_ID, SPEC_FILE, STATE_DIR,
  agenticsRoot, configPath, contextDir, effortDir, effortStateDir, effortsRoot, evidenceStoreDir,
  folderDir, mainCheckout, mkdirState, projectStateDir, readConfig, safeSlug, slotsDir, specPath,
} from '../lib/store.mjs'

const fresh = (area) => mkdtempSync(join(tmpdir(), 'agentics-store-' + area + '-'))

const git = (cwd, ...args) => execFileSync('git', [
  '-C', cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=T', '-c', 'protocol.file.allow=always', ...args,
], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function gitRepo(area) {
  const dir = fresh(area)
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'base')
  return dir
}

/** One spelling per directory on disk: real path, forward slashes, and case-folded on Windows. */
const canon = (p) => {
  const real = realpathSync.native(p).split('\\').join('/')
  return process.platform === 'win32' ? real.toLowerCase() : real
}
/** The same spelling for a path that need not exist: resolved lexically. */
const spell = (p) => {
  const s = resolve(p).split('\\').join('/')
  return process.platform === 'win32' ? s.toLowerCase() : s
}
const sameDir = (a, b) => canon(a) === canon(b)
/** `child` sits directly in `parent`, compared lexically. */
const directlyIn = (child, parent) => spell(dirname(child)) === spell(parent)

// ------------------------------------------------------------------ the layout

test('the store root is .agentics in the repository, and it ignores itself', () => {
  const r = gitRepo('root')
  assert.ok(sameDir(dirname(agenticsRoot(r)), r), 'the root sits in the checkout itself')
  assert.equal(basename(agenticsRoot(r)), AGENTICS_DIR)

  mkdirState(effortStateDir(r, 'e'))
  assert.equal(readFileSync(join(agenticsRoot(r), '.gitignore'), 'utf8'), '*\n')
  assert.equal(git(r, 'status', '--porcelain'), '', 'nothing under the store shows up as a change')
})

test('a directory made outside .agentics gets no .gitignore', () => {
  const r = fresh('outside')
  mkdirState(join(r, 'other', 'deeper'))
  assert.equal(existsSync(join(r, 'other', 'deeper', '.gitignore')), false)
  assert.equal(existsSync(join(r, 'other', '.gitignore')), false)
  assert.equal(existsSync(join(r, '.gitignore')), false)
})

test('the project-wide machinery sits in .agentics/.state', () => {
  const r = fresh('project')
  assert.ok(directlyIn(projectStateDir(r), agenticsRoot(r)))
  assert.equal(basename(projectStateDir(r)), STATE_DIR)
  for (const dir of [slotsDir(r), contextDir(r), evidenceStoreDir(r)]) {
    assert.ok(directlyIn(dir, projectStateDir(r)), dir + ' is directly in the project .state/')
  }
  assert.equal(new Set([slotsDir(r), contextDir(r), evidenceStoreDir(r)].map(spell)).size, 3)
})

test('the settings file is the one file directly in .agentics', () => {
  const r = fresh('config')
  assert.ok(directlyIn(configPath(r), agenticsRoot(r)))
  assert.equal(basename(configPath(r)), CONFIG_FILE)
})

test('every effort is a directory of .agentics, with its machine state in its own .state', () => {
  const r = fresh('effort')
  assert.equal(spell(effortsRoot(r)), spell(agenticsRoot(r)))
  assert.ok(directlyIn(effortDir(r, 'e1'), agenticsRoot(r)))
  assert.equal(basename(effortDir(r, 'e1')), 'e1')
  assert.ok(directlyIn(effortStateDir(r, 'e1'), effortDir(r, 'e1')))
  assert.equal(basename(effortStateDir(r, 'e1')), STATE_DIR)
})

test('a folder is the effort directory for the root, and its id\'s segments below it otherwise', () => {
  const r = fresh('folder')
  assert.equal(spell(folderDir(r, 'e1', ROOT_ID)), spell(effortDir(r, 'e1')))
  const nested = folderDir(r, 'e1', 'foundations/entities')
  assert.deepEqual(relative(effortDir(r, 'e1'), nested).split(/[\\/]/), ['foundations', 'entities'])
  assert.ok(directlyIn(folderDir(r, 'e1', 'a'), effortDir(r, 'e1')))
})

test('every folder\'s spec is SPEC.md inside the folder', () => {
  const r = fresh('spec')
  for (const id of [ROOT_ID, 'a', 'a/b/c']) {
    assert.ok(directlyIn(specPath(r, 'e1', id), folderDir(r, 'e1', id)), 'the spec of ' + id)
    assert.equal(basename(specPath(r, 'e1', id)), SPEC_FILE)
  }
})

test('no file name the store writes can pass for an effort or a folder', () => {
  // listEfforts and every folder walk skip what fails the segment rule, so these must fail it.
  for (const name of [STATE_DIR, SPEC_FILE, EVIDENCE_RENDER, CONFIG_FILE, '.gitignore']) {
    assert.equal(safeSlug(name), null, name)
  }
  assert.notEqual(SPEC_FILE, EVIDENCE_RENDER)
})

// ------------------------------------------------------------------ the segment rule

test('the segment rule accepts lower-case letters, digits and single dashes, up to 120 characters', () => {
  for (const name of ['a', '0', 'a-b', 'e1', '2026-09-26-fix-it', 'x'.repeat(120)]) {
    assert.equal(safeSlug(name), name, JSON.stringify(name))
  }
})

test('the segment rule refuses dots, underscores, capitals, a double dash and 121 characters', () => {
  for (const name of ['.state', 'a.b', 'a_b', 'A', 'aB', 'a--b', 'x'.repeat(121), '', '-a', 'a/b',
    '..', '.', ' a', 'a ', 'é']) {
    assert.equal(safeSlug(name), null, JSON.stringify(name))
  }
  for (const value of [null, undefined, 7, {}, ['a']]) assert.equal(safeSlug(value), null)
})

// ------------------------------------------------------------------ config.json

test('readConfig is {} for a missing, garbled or non-object file, and the object otherwise', () => {
  const r = fresh('readconfig')
  assert.deepEqual(readConfig(r), {})

  mkdirState(dirname(configPath(r)))
  for (const text of ['{nope', '', '[1, 2]', '"text"', '42', 'null']) {
    writeFileSync(configPath(r), text)
    assert.deepEqual(readConfig(r), {}, JSON.stringify(text))
  }

  writeFileSync(configPath(r), JSON.stringify({ max_parallel: 3, evidence_max_age_days: 10 }))
  const config = readConfig(r)
  assert.equal(config.max_parallel, 3)
  assert.equal(config.evidence_max_age_days, 10)
})

// ------------------------------------------------------------------ the main checkout

test('a directory git does not know is its own main checkout', () => {
  const r = fresh('nogit')
  assert.equal(spell(mainCheckout(r)), spell(r))
})

test('a plain directory inside a repository is not that repository', () => {
  // A temp directory under a repository (a dotfiles repo at the home directory) must never send
  // its state into the enclosing repository.
  const r = gitRepo('enclosing')
  const inner = join(r, 'nested')
  mkdirSync(inner)
  assert.equal(spell(mainCheckout(inner)), spell(inner))
})

test('a main checkout resolves to itself', () => {
  const r = gitRepo('main')
  assert.ok(sameDir(mainCheckout(r), r))
})

test('a writer in a linked worktree lands its state in the main checkout', () => {
  const main = gitRepo('wt-main')
  const wt = join(fresh('wt-linked'), 'wt')
  git(main, 'worktree', 'add', '-q', '-b', 'side', wt)

  assert.ok(sameDir(mainCheckout(wt), main))
  assert.equal(spell(effortDir(wt, 'e')), spell(effortDir(main, 'e')))

  const out = append(wt, 'e', 'events', { kind: 'planned', node: '.' })
  assert.equal(out.ok, true, out.error)
  assert.equal(readLog(main, 'e', 'events').entries.length, 1, 'the main checkout reads what the worktree wrote')
  assert.equal(existsSync(join(wt, AGENTICS_DIR)), false, 'the worktree holds no store of its own')
})

test('a worktree under the main checkout\'s .claude/worktrees resolves to the checkout, not itself', () => {
  const main = gitRepo('wt-nested')
  const wt = join(main, '.claude', 'worktrees', 'e--a')
  git(main, 'worktree', 'add', '-q', '-b', 'agentics/e--a', wt)

  assert.ok(sameDir(mainCheckout(wt), main))
  assert.ok(directlyIn(agenticsRoot(wt), mainCheckout(main)))
  assert.equal(spell(configPath(wt)), spell(configPath(main)))
})

test('a submodule and a linked worktree of it both resolve to the submodule\'s checkout', () => {
  const sub = gitRepo('sm-origin')
  const sup = gitRepo('sm-super')
  git(sup, 'submodule', 'add', '-q', sub.split('\\').join('/'), 'mod')
  const mod = join(sup, 'mod')
  assert.ok(sameDir(mainCheckout(mod), mod), 'never the superproject\'s .git/modules/ directory')

  const wt = join(fresh('sm-wt'), 'wt')
  git(mod, 'worktree', 'add', '-q', '-b', 'side', wt)
  assert.ok(sameDir(mainCheckout(wt), mod))
})

test('readConfig from a worktree reads the main checkout\'s settings', () => {
  const main = gitRepo('cfg-main')
  const wt = join(fresh('cfg-wt'), 'wt')
  git(main, 'worktree', 'add', '-q', '-b', 'side', wt)
  mkdirState(dirname(configPath(main)))
  writeFileSync(configPath(main), JSON.stringify({ max_parallel: 2 }))
  assert.equal(readConfig(wt).max_parallel, 2)
})
