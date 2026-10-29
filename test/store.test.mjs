// test/store.test.mjs — where agentics keeps its state: `.agentics/` in the main checkout, the
// project-wide `.state/`, one directory per effort and per folder, the segment rule, the project
// settings file and the lock every writer shares.
//
// Design: docs/DESIGN.md#storage.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync,
} from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'

import { append, readLog } from '../lib/ledger.mjs'
import {
  AGENTICS_DIR, CONFIG_FILE, EVIDENCE_RENDER, ROOT_ID, SPEC_FILE, STATE_DIR, blobsAt,
  agenticsRoot, configPath, contextDir, effortDir, effortStateDir, effortsRoot,
  evidenceStoreDir, executionDir, executionsRoot, folderDir, mainCheckout, mkdirState,
  projectStateDir, readConfig, returnPath, safeSlug, saidOf, slotsDir, specPath, withLock, writeJson,
} from '../lib/store.mjs'
import { DEAD_PID } from './harness/dead-pid.mjs'

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

test('every folder\'s spec is DESIGN.md inside the folder', () => {
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

test('an effort\'s executions sit in its .state', () => {
  const r = fresh('executions')
  assert.ok(directlyIn(executionsRoot(r, 'e1'), effortStateDir(r, 'e1')))
  assert.ok(directlyIn(executionDir(r, 'e1', '20260926-120000'), executionsRoot(r, 'e1')))
})

// ------------------------------------------------------------------ what a record said

const SAID_STAMP = '20260926-120000'
const SAID_DISPATCH = 'x.implementer.producer-x.r1'

/** A store whose execution holds `ret` as the stored return of SAID_DISPATCH (none when undefined). */
function saidStore(ret) {
  const r = fresh('said')
  if (ret !== undefined) writeJson(returnPath(executionDir(r, 'e1', SAID_STAMP), SAID_DISPATCH), ret)
  return r
}
const naming = (fields) => ({ execution: SAID_STAMP, said: SAID_DISPATCH, ...fields })

test('saidOf gives the line the lib composed, then the stored return\'s text', () => {
  const text = 'Keep the cache?\nIt costs 2 GB.'
  const r = saidStore({ status: 'blocked', text })
  assert.equal(saidOf(r, 'e1', naming({ kind: 'parked', node: 'x', question: 'needs a decision' })), 'needs a decision\n' + text)
  assert.equal(saidOf(r, 'e1', naming({ kind: 'escalated', node: 'x', detail: 'blocked twice' })), 'blocked twice\n' + text)
  assert.equal(saidOf(r, 'e1', naming({ kind: 'parked', node: 'x', question: '' })), text)
})

test('saidOf gives the return\'s notes when it has no text', () => {
  const notes = 'The criteria hold: the CLI prints a Next line.'
  const r = saidStore({ units: [], findings: [], fix_rulings: [], claims: [], notes })
  assert.equal(saidOf(r, 'e1', naming({ kind: 'claims', node: '.' })), notes)
})

test('saidOf gives the ruling for the record\'s node when the return has no text or notes', () => {
  const rulings = [
    { node: 'a', ruling: 'affected', why: 'the sum moved', question: 'keep the order?' },
    { node: 'b', ruling: 'unaffected', why: 'nothing it reads moved', question: '' },
  ]
  const r = saidStore({ rulings })
  assert.equal(saidOf(r, 'e1', naming({ kind: 'parked', node: 'a', question: '' })), rulings[0].why + '\n' + rulings[0].question)
  assert.equal(saidOf(r, 'e1', naming({ kind: 'parked', node: 'b', question: 'drift' })), 'drift\n' + rulings[1].why)
  assert.equal(saidOf(r, 'e1', naming({ kind: 'parked', node: 'c', question: 'drift' })), 'drift', 'a ruling for another node says nothing here')
})

test('saidOf gives the line alone with no said or no readable return', () => {
  const r = saidStore(undefined)
  assert.equal(saidOf(r, 'e1', { kind: 'escalated', node: 'x', execution: SAID_STAMP, detail: 'merge conflict in a.js' }), 'merge conflict in a.js')
  assert.equal(saidOf(r, 'e1', naming({ kind: 'parked', node: 'x', question: 'the line' })), 'the line', 'a return never stored')
  const unreadable = returnPath(executionDir(r, 'e1', SAID_STAMP), SAID_DISPATCH)
  mkdirSync(dirname(unreadable), { recursive: true })
  writeFileSync(unreadable, '{"text": "cut')
  assert.equal(saidOf(r, 'e1', naming({ kind: 'parked', node: 'x', question: 'the line' })), 'the line', 'a return that is not JSON')
  const file = join(r, 'q.md')
  writeFileSync(file, 'what a 4.x author wrote\n')
  assert.equal(saidOf(r, 'e1', { kind: 'parked', node: 'x', execution: SAID_STAMP, question: 'the line', said: file }), 'the line',
    'a said that is a file path names no dispatch')
  writeJson(join(executionDir(r, 'e1', SAID_STAMP), 'outside.json'), { text: 'outside returns/' })
  assert.equal(saidOf(r, 'e1', naming({ kind: 'parked', node: 'x', question: 'the line', said: '../outside' })), 'the line',
    'a said that climbs out of returns/ names no dispatch')
  writeJson(returnPath(executionDir(r, 'e1', 'bogus'), SAID_DISPATCH), { text: 'from a home that is no execution' })
  assert.equal(saidOf(r, 'e1', { kind: 'parked', node: 'x', execution: 'bogus', question: 'the line', said: SAID_DISPATCH }), 'the line',
    'an execution that is no stamp names no home')
  assert.equal(saidOf(r, 'e1', null), '')
})

// ------------------------------------------------------------------ the lock


/** Put the holder file of a holder that is gone into the lock directory at `path`. */
const goneHolder = (path) =>
  writeFileSync(join(path, 'gone'), JSON.stringify({ pid: DEAD_PID, host: hostname(), at: new Date().toISOString() }))

const attempt = (path, waitMs) => {
  try {
    return withLock(path, () => 'taken', { waitMs })
  } catch (err) {
    return err.message
  }
}

test('a lock whose holder is gone is broken and taken', () => {
  const path = join(fresh('lock'), 'held')
  mkdirSync(path, { recursive: true })
  goneHolder(path)
  assert.equal(attempt(path, 5000), 'taken')
  assert.equal(existsSync(path), false, 'released afterwards')
})

test('breaking a gone holder never frees a lock someone holds now', () => {
  const dir = fresh('lock')
  const path = join(dir, 'held')
  withLock(path, () => {
    const mine = readdirSync(path)
    // A waiter judged a holder gone while the lock changed hands: the name it judged is in the
    // lock it acts on now, beside the holder that took it since.
    goneHolder(path)
    assert.match(attempt(path, 100), /could not take the lock/)
    assert.deepEqual(readdirSync(path), mine, 'the gone holder was removed and the live one kept')
    assert.deepEqual(readdirSync(dir), ['held'], 'a waiter that gave up leaves nothing beside the lock')
  })
  assert.equal(existsSync(path), false)
})

test('blobsAt: each path names its content at a commit, from the root whatever the cwd; a path the commit lacks is absent', () => {
  const r = gitRepo('blobs')
  mkdirSync(join(r, 'sub'))
  writeFileSync(join(r, 'sub', 'a.txt'), 'one\n')
  writeFileSync(join(r, 'b.txt'), 'one\n')
  git(r, 'add', '.')
  git(r, 'commit', '-q', '-m', 'first')
  const first = git(r, 'rev-parse', 'HEAD')
  writeFileSync(join(r, 'b.txt'), 'two\n')
  git(r, 'commit', '-q', '-am', 'second')
  const at = blobsAt(join(r, 'sub'), 'HEAD', ['sub/a.txt', 'b.txt', 'gone.txt'])
  assert.deepEqual([...at.keys()].sort(), ['b.txt', 'sub/a.txt'])
  assert.equal(at.get('sub/a.txt'), git(r, 'rev-parse', 'HEAD:sub/a.txt'))
  assert.equal(at.get('b.txt'), git(r, 'rev-parse', 'HEAD:b.txt'))
  assert.notEqual(blobsAt(r, first, ['b.txt']).get('b.txt'), at.get('b.txt'), 'another content, another blob')
})
