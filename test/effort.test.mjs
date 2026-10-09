// test/effort.test.mjs — an effort's identity and evidence on a real filesystem, and its own git
// status.
//
// What is pinned here:
//
//   naming       the slug is the directory name, entire; no identity file restates it; no `--`
//   opening      idempotent, and the second opener adopts the first's account of the effort
//   reading      identity, node count and executions are derived from disk
//
// Design: docs/DESIGN.md#storage, docs/DESIGN.md#survey.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { approvalState, recordApproval } from '../lib/approval.mjs'
import {
  createSubEffortFolder, listEfforts, openEffort, readEffort, renameSubEffort,
  safeSlug, slugFor, stampNow,
} from '../lib/effort.mjs'
import { append, readLog } from '../lib/ledger.mjs'
import { SECTIONS, checkFolder, hashSpec, parseSpec } from '../lib/spec.mjs'
import { effortStateDir } from '../lib/store.mjs'
import * as store from '../lib/store.mjs'

const CLI = fileURLToPath(new URL('../lib/effort.mjs', import.meta.url))
const fresh = () => mkdtempSync(join(tmpdir(), 'agentics-effort-')).split('\\').join('/')
const effortPath = (repo, slug, ...rest) => join(effortStateDir(repo, slug), ...rest)

const run = (...args) => JSON.parse(execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }))

test('names and stamps are lib/store.mjs\'s, not a second copy', () => {
  assert.equal(safeSlug, store.safeSlug)
  assert.equal(stampNow, store.stampNow)
})

test('a proposed name is the first four words, kebab, undated, and passes the segment rule', () => {
  const about = 'Efforts, and what a probe should cost'
  assert.equal(slugFor(about), about.toLowerCase().match(/[a-z0-9]+/g).slice(0, 4).join('-'))
  assert.equal(slugFor(''), 'effort')
  assert.equal(slugFor('a -- b'), 'a-b')
  for (const text of [about, '', 'a -- b', 'x'.repeat(300) + ' y']) {
    const name = slugFor(text)
    assert.equal(safeSlug(name), name, text)
    assert.ok(name.split('-').length <= 4, name)
  }
})

test('a slug that could climb out of the store, or blur a branch prefix, is refused', () => {
  assert.equal(safeSlug('../../etc'), null)
  assert.equal(safeSlug('a/b'), null)
  assert.equal(safeSlug('..'), null)
  assert.equal(safeSlug(''), null)
  assert.equal(safeSlug('a--b'), null)
  assert.equal(safeSlug('2026-09-04-ok'), '2026-09-04-ok')
  assert.equal(openEffort(fresh(), { slug: 'a--b', about: 'x' }).ok, false)
})

test('opening is idempotent, and no identity file restates the directory name', () => {
  const repo = fresh()
  const first = openEffort(repo, { slug: 'e1', about: 'the change', roots: 'a,b' })
  assert.equal(first.ok, true)
  assert.equal(first.created, true)

  const identity = JSON.parse(readFileSync(effortPath(repo, 'e1', 'effort.json'), 'utf8'))
  assert.deepEqual(Object.keys(identity).sort(), ['about', 'opened_at', 'roots'])
  assert.deepEqual(identity.roots, ['a', 'b'])

  const second = openEffort(repo, { slug: 'e1', about: 'something else entirely' })
  assert.equal(second.created, false)
  assert.equal(second.about, 'the change',
    'the second opener adopts what the first recorded rather than overwriting it')
})

test('reading derives identity, node count and executions from disk', () => {
  const repo = fresh()
  openEffort(repo, { slug: 'e1', about: 'the change', roots: ['src'] })
  append(repo, 'e1', 'nodes', [
    { kind: 'node', node: { id: '.', title: 'root', kind: 'composite' } },
    { kind: 'node', node: { id: 'a', title: 'a', kind: 'leaf' } },
    { kind: 'node', node: { id: 'a', title: 'a again', kind: 'leaf' } },
    { kind: 'node', node: { id: 'b', title: 'gone', kind: 'leaf', retired: true } },
  ])
  mkdirSync(effortPath(repo, 'e1', 'executions', '20260904-130000'), { recursive: true })
  mkdirSync(effortPath(repo, 'e1', 'executions', 'not-a-stamp'), { recursive: true })

  const read = readEffort(repo, 'e1')
  assert.equal(read.exists, true)
  assert.deepEqual(read.identity.roots, ['src'])
  assert.equal(read.identity.about, 'the change')
  assert.equal(read.nodes_n, 2, 'latest revision per id, retired dropped')
  assert.deepEqual(read.executions, ['20260904-130000'])
  assert.match(read.notes, /derived from disk/)
  assert.ok(!('evidence' in read) && !('latest' in read), 'evidence is lib/evidence.mjs\'s, not the effort\'s')
})

test('an effort nobody opened reads as absent rather than as empty', () => {
  const read = readEffort(fresh(), 'ghost')
  assert.equal(read.exists, false)
  assert.equal(read.identity, null)
  assert.ok(!('evidence' in read))
  assert.match(read.notes, /no effort named ghost/)
})

test('listing a repository with no store says so instead of returning an empty success', () => {
  const out = listEfforts(fresh())
  assert.equal(out.store_present, false)
  assert.deepEqual(out.efforts, [])
})

test('listing names each effort and its executions, newest name first', () => {
  const repo = fresh()
  openEffort(repo, { slug: 'a1', about: 'first' })
  openEffort(repo, { slug: 'b2', about: 'second' })
  mkdirSync(effortPath(repo, 'b2', 'executions', '20260904-130000'), { recursive: true })

  const out = listEfforts(repo)
  assert.deepEqual(out.efforts.map((e) => e.effort), ['b2', 'a1'])
  assert.deepEqual(out.efforts[0].executions, ['20260904-130000'])
  assert.deepEqual(out.efforts[1].executions, [], 'a1 has no nodes and no executions, and is listed for being opened')
  for (const row of out.efforts) assert.ok(!('surveys' in row) && !('probes' in row), row.effort)
})

test('the CLI opens an effort, by positionals or by flags', () => {
  const repo = fresh()
  assert.equal(run('open', repo, 'e1', '--about', 'the change', '--roots', repo).created, true)
  assert.equal(readEffort(repo, 'e1').exists, true)
  assert.equal(run('open', '--repo', repo, '--effort', 'e2', '--about', 'another change').created, true)
  assert.deepEqual(listEfforts(repo).efforts.map((e) => e.effort).sort(), ['e1', 'e2'])
})

test('the CLI has no link, record, standing, read or list verb: evidence is lib/evidence.mjs\'s, and reads are in-process', () => {
  const repo = fresh()
  assert.equal(openEffort(repo, { slug: 'e1', about: 'x', roots: repo }).ok, true)
  for (const args of [['link', repo, 'e1', 'run', '--value', 'x'], ...['record', 'standing', 'read', 'list'].map((verb) => [verb, repo, 'e1'])]) {
    assert.throws(() => execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: 'pipe' }), args[0])
  }
})

test('the slug command needs no repository and proposes an undated name', () => {
  const words = 'Efforts and what a probe should cost'
  const out = run('slug', words)
  assert.equal(out.ok, true)
  assert.equal(out.slug, slugFor(words))
  assert.doesNotMatch(out.slug, /^\d{4}-\d{2}-\d{2}-/)
})

// ------------------------------------------------------------------ folders
//
// A sub-effort's folder is created as a skeleton spec under a parent that has one, and renamed
// among its siblings with every id and path that names it. Approval is a hash on an append-only
// ledger, so a rename carries a folder's approval by a new line for the renamed text, never by
// rewriting the old one, and never for text nobody approved.

const E = 'e1'
const ROOT_SPEC = [
  '# Parse configs', '', '## Intent', '', 'Configs load from disk.', '',
  '## Decisions', '', '| id | decision | why |', '|---|---|---|', '| D1 | Keys are case-insensitive. | Users type them by hand. |', '',
  '## Design', '', 'A loader and a parser.', '',
  '## Plan', '',
  '- **api** — sub-effort · realises: D1 · provides: config-api (src/api/)', '  Build the config api',
  '- **cli** — task · realises: D1 · after: api · consumes: config-api · rigor: tdd · locus: src/cli.js',
  '  Read configs from the command line', '  - [ ] the CLI loads a config — check: `node --test`', '',
  '## Open questions', '', '## Evidence', '', 'None yet.', '',
].join('\n')
const API_SPEC = [
  '# The config api', '', '## Intent', '', 'A loader and a parser in src/api.', '',
  '## Decisions', '', '| id | decision | why |', '|---|---|---|', '| api.D1 | The loader returns a plain object. | Callers need no class. |', '',
  '## Design', '', 'See api.D1: `load(path)`, then `parse(text)`.', '',
  '## Plan', '',
  '- **parse** — sub-effort · realises: D1, api.D1', '  Parse keys',
  '- **types** — task · realises: api.D1 · after: /api/parse · rigor: tdd · locus: src/api/types.js',
  '  Declare the config type', '  - [ ] HUMAN: the type reads well', '',
  '## Open questions', '', '## Evidence', '', 'None yet.', '',
].join('\n')
const PARSE_SPEC = [
  '# Parse keys', '', '## Intent', '', 'One pass over the text.', '',
  '## Decisions', '', '| id | decision | why |', '|---|---|---|', '| api.parse.D1 | Parsing is one pass. | Configs are small. |', '',
  '## Design', '', 'A tokenizer.', '',
  '## Plan', '',
  '- **tokens** — task · realises: D1, api.D1, api.parse.D1 · rigor: tdd · locus: src/api/tokens.js',
  '  Tokenize the config', '  - [ ] tokens split on newlines — check: `node --test`', '',
  '## Open questions', '', '## Evidence', '', 'None yet.', '',
].join('\n')

function putSpec(repo, id, text) {
  mkdirSync(dirname(store.specPath(repo, E, id)), { recursive: true })
  writeFileSync(store.specPath(repo, E, id), text)
}
const readSpec = (repo, id) => readFileSync(store.specPath(repo, E, id), 'utf8')
const ledgerOf = (repo) => readLog(repo, E, 'ledger').entries
const entryOf = (text, name) => parseSpec(text).entries.find((e) => e.name === name)

/** An effort with the root, `api` and `api/parse` specs on disk, each approved. */
function approvedEffort() {
  const repo = fresh()
  putSpec(repo, '.', ROOT_SPEC)
  putSpec(repo, 'api', API_SPEC)
  putSpec(repo, 'api/parse', PARSE_SPEC)
  for (const id of ['.', 'api', 'api/parse']) {
    const out = recordApproval(repo, E, id)
    assert.equal(out.ok, true, id + ': ' + out.error)
  }
  return repo
}

/** Every spec's bytes and the ledger, to prove a refused call changed nothing. */
const disk = (repo) => ({
  specs: ['.', 'api', 'api/parse', 'loader', 'loader/parse'].map((id) => (existsSync(store.specPath(repo, E, id)) ? readSpec(repo, id) : null)),
  ledger: ledgerOf(repo),
})

test('a sub-effort folder starts as a skeleton spec that parses, under a parent that has one', () => {
  const repo = fresh()
  putSpec(repo, '.', ROOT_SPEC)
  const out = createSubEffortFolder(repo, E, 'api', { title: 'The config api' })
  assert.equal(out.ok, true, out.error)
  assert.equal(out.folder, 'api')
  const spec = parseSpec(readSpec(repo, 'api'))
  assert.deepEqual(spec.problems, [])
  assert.equal(spec.title, 'The config api')
  assert.deepEqual(Object.keys(spec.sections), SECTIONS)
  for (const name of SECTIONS) assert.equal(spec.sections[name].body.replace(/^\|.*\|$/gm, '').trim(), '', name + ' is empty')
  assert.deepEqual([spec.decisions, spec.questions, spec.entries], [[], [], []])

  assert.equal(createSubEffortFolder(repo, E, 'cli', {}).ok, true)
  assert.equal(parseSpec(readSpec(repo, 'cli')).title, 'cli', 'no title: the folder\'s name')
  assert.equal(createSubEffortFolder(repo, E, 'api/parse', { title: 'Parse keys' }).ok, true, 'nested under a parent that has a spec')
})

test('a folder is refused, and nothing written, at the root, with a bad name, without a parent spec, or over a spec', () => {
  const repo = fresh()
  putSpec(repo, '.', ROOT_SPEC)
  putSpec(repo, 'api', API_SPEC)
  for (const id of ['.', 'Api_v2', 'a--b', '../x', 'ghost/parse']) {
    assert.equal(createSubEffortFolder(repo, E, id, { title: 't' }).ok, false, id)
  }
  assert.equal(existsSync(store.folderDir(repo, E, 'ghost')), false, 'a refused folder leaves no directory')
  assert.equal(createSubEffortFolder(repo, E, 'api', { title: 't' }).ok, false, 'an existing spec is never overwritten')
  assert.equal(readSpec(repo, 'api'), API_SPEC)
})

test('the folder CLI creates the skeleton, and exits non-zero on a refusal', () => {
  const repo = fresh()
  putSpec(repo, '.', ROOT_SPEC)
  const out = run('folder', repo, E, 'api', '--title', 'The config api')
  assert.equal(out.ok, true)
  assert.equal(parseSpec(readSpec(repo, 'api')).title, 'The config api')
  assert.throws(() => execFileSync(process.execPath, [CLI, 'folder', repo, E, 'api'], { encoding: 'utf8', stdio: 'pipe' }))
})

test('a rename moves the folder and renames every id and path that names it; every spec still checks', () => {
  const repo = approvedEffort()
  const out = renameSubEffort(repo, E, 'api', 'loader')
  assert.equal(out.ok, true, out.error)
  assert.deepEqual([out.from, out.to], ['api', 'loader'])

  assert.equal(existsSync(store.folderDir(repo, E, 'api')), false)
  assert.ok(existsSync(store.specPath(repo, E, 'loader')))
  assert.ok(existsSync(store.specPath(repo, E, 'loader/parse')), 'what is below it moves with it')

  const root = readSpec(repo, '.')
  assert.deepEqual(parseSpec(root).entries.map((e) => e.name), ['loader', 'cli'])
  assert.deepEqual(entryOf(root, 'cli').after, ['loader'])
  const loader = readSpec(repo, 'loader')
  assert.deepEqual(parseSpec(loader).decisions.map((d) => d.id), ['loader.D1'])
  assert.deepEqual(entryOf(loader, 'types').after, ['/loader/parse'])
  assert.match(loader, /See loader\.D1:/, 'the id is renamed wherever it stands')
  const parse = readSpec(repo, 'loader/parse')
  assert.deepEqual(parseSpec(parse).decisions.map((d) => d.id), ['loader.parse.D1'])
  assert.deepEqual(entryOf(parse, 'tokens').realises, ['D1', 'loader.D1', 'loader.parse.D1'])

  for (const id of ['.', 'loader', 'loader/parse']) assert.deepEqual(checkFolder(repo, E, id).problems, [], id)
  assert.deepEqual([...out.rewritten].sort(), ['.', 'loader', 'loader/parse'].map((id) => checkFolder(repo, E, id).file).sort())
})

test('a rename carries each approval by a new ledger line for the renamed text, and rewrites no old line', () => {
  const repo = approvedEffort()
  const before = ledgerOf(repo)
  const out = renameSubEffort(repo, E, 'api', 'loader')
  assert.equal(out.ok, true, out.error)

  const after = ledgerOf(repo)
  assert.deepEqual(after.slice(0, before.length), before, 'append-only')
  const added = after.slice(before.length)
  assert.deepEqual(added.map((l) => [l.kind, l.folder, l.renamed_from]).sort(),
    [['approved', 'loader', 'api'], ['approved', 'loader/parse', 'api/parse']])
  assert.deepEqual([...out.carried].sort(), ['loader', 'loader/parse'])
  for (const l of added) assert.equal(l.hash, hashSpec(readSpec(repo, l.folder)), l.folder)

  const loader = approvalState(repo, E, 'loader')
  assert.equal(loader.state, 'approved')
  assert.deepEqual(loader.decisions, [{ id: 'loader.D1', text: 'The loader returns a plain object.' }])
  assert.equal(approvalState(repo, E, 'loader/parse').state, 'approved')
  assert.equal(approvalState(repo, E, '.').state, 'edited', 'its plan changed: the user approves the parent again')
})

test('a folder edited since its approval carries no approval through a rename', () => {
  const repo = approvedEffort()
  putSpec(repo, 'api', API_SPEC.replace('A loader and a parser in src/api.', 'A loader, a parser and a cache in src/api.'))
  const out = renameSubEffort(repo, E, 'api', 'loader')
  assert.equal(out.ok, true, out.error)
  assert.ok(!out.carried.includes('loader'))
  assert.notEqual(approvalState(repo, E, 'loader').state, 'approved')
  assert.equal(approvalState(repo, E, 'loader/parse').state, 'approved', 'its child was approved as it stood')
})

test('a rename is refused, changing nothing, for a bad id, another parent, an unknown entry or a taken name', () => {
  const repo = approvedEffort()
  const was = disk(repo)
  for (const [from, to] of [
    ['.', 'loader'], ['api', '.'], ['api', 'Loader'], ['api', 'a--b'],
    ['api', 'cli/loader'], ['api/parse', 'lexer/parse'],
    ['ghost', 'loader'], ['api', 'cli'],
  ]) {
    assert.equal(renameSubEffort(repo, E, from, to).ok, false, from + ' → ' + to)
  }
  mkdirSync(store.folderDir(repo, E, 'loader'), { recursive: true })
  assert.equal(renameSubEffort(repo, E, 'api', 'loader').ok, false, 'a directory already there')
  assert.deepEqual(disk(repo), was)
})

test('a rename is refused while any node at or below the folder has dispatched or merged work', () => {
  for (const [kind, node] of [['dispatched', 'api/parse/tokens'], ['merged', 'api']]) {
    const repo = approvedEffort()
    assert.equal(append(repo, E, 'events', { kind, node, execution: '20260926-120000', role: 'implementer', round: 1 }).ok, true)
    const was = disk(repo)
    const out = renameSubEffort(repo, E, 'api', 'loader')
    assert.equal(out.ok, false, kind)
    assert.ok(out.error.includes(node), out.error)
    assert.deepEqual(disk(repo), was)
  }
  const elsewhere = approvedEffort()
  append(elsewhere, E, 'events', { kind: 'dispatched', node: 'cli', execution: '20260926-120000', role: 'implementer', round: 1 })
  assert.equal(renameSubEffort(elsewhere, E, 'api', 'loader').ok, true, 'work on a sibling does not hold it')
})

test('a renamed spec keeps its CRLF endings', () => {
  const repo = approvedEffort()
  putSpec(repo, 'api', API_SPEC.replace(/\n/g, '\r\n'))
  assert.equal(recordApproval(repo, E, 'api').ok, true)
  assert.equal(renameSubEffort(repo, E, 'api', 'loader').ok, true)
  const text = readSpec(repo, 'loader')
  assert.equal(text.split('\r\n').length, text.split('\n').length, 'every line still ends in CRLF')
  assert.equal(approvalState(repo, E, 'loader').state, 'approved')
})

test('the rename CLI renames, and exits non-zero on a refusal', () => {
  const repo = approvedEffort()
  const out = run('rename', repo, E, '--from', 'api', '--to', 'loader')
  assert.equal(out.ok, true)
  assert.ok(existsSync(store.specPath(repo, E, 'loader')))
  assert.throws(() => execFileSync(process.execPath, [CLI, 'rename', repo, E, '--from', 'api', '--to', 'x'], { encoding: 'utf8', stdio: 'pipe' }))
})

// ------------------------------------------------------------------ git status
//
// The effort store must not appear as a change to commit: `.agentics/` carries its own gitignore.

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

function put(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, ...path.split('/'))
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
}

function gitRepo() {
  const dir = fresh()
  git(dir, 'init', '-q', '.')
  git(dir, 'config', 'user.email', 't@t')
  git(dir, 'config', 'user.name', 't')
  put(dir, { 'src/a/x.js': 'x\n', 'src/b/y.js': 'y\n' })
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'init')
  return dir
}

test('the store ignores itself: an opened effort and its records leave git status clean', () => {
  const repo = gitRepo()
  openEffort(repo, { slug: 'e1', about: 'x' })

  assert.equal(git(repo, 'status', '--porcelain'), '', 'local state never shows up as a change to commit')
  assert.equal(readFileSync(join(repo, store.AGENTICS_DIR, '.gitignore'), 'utf8'), '*\n')
})

test('a rename rewrites a group heading\'s after, and a group\'s name counts as taken', () => {
  const repo = approvedEffort()
  const group = '### watch — group · after: api\nWatch configs\n\n- **reload** — task · rigor: trivial · locus: src/reload.js\n  Reload configs\n  - [ ] it reloads — check: `node --test`\n\n'
  putSpec(repo, '.', readSpec(repo, '.').replace('## Open questions', group + '## Open questions'))
  assert.equal(renameSubEffort(repo, E, 'api', 'watch').ok, false, 'a group already holds the name')
  assert.equal(renameSubEffort(repo, E, 'api', 'loader').ok, true)
  assert.deepEqual(parseSpec(readSpec(repo, '.')).groups[0].after, ['loader'])
})

test('the effort CLI refuses a value that is not a handle, a free text past its line, and a flag it does not take', () => {
  const refusal = (...args) => {
    try {
      execFileSync(process.execPath, [CLI, ...args], {
        encoding: 'utf8', stdio: 'pipe', env: { ...process.env, NODE_TEST_CONTEXT: '' }, timeout: 30_000,
      })
      return [0, '']
    } catch (err) {
      return [err.status, JSON.parse(err.stdout).kind]
    }
  }
  const repo = fresh()
  assert.deepEqual(refusal('slug', 'one\ntwo'), [1, 'args_unreadable'])
  assert.deepEqual(refusal('open', repo, 'e1', '--about', 'x'.repeat(301)), [1, 'args_unreadable'])
  assert.deepEqual(refusal('open', repo, 'e1', '--about', 'the change', '--roots', 'src\nlib'), [1, 'args_unreadable'])
  assert.deepEqual(refusal('open', repo, 'e1', '--about', 'the change', '--link', 'x'), [1, 'unknown_flag'])
  assert.equal(existsSync(effortPath(repo, 'e1')), false, 'nothing was opened')
  const about = 'the "loader", in the user\'s words — see `load()`'
  assert.equal(run('open', repo, 'e1', '--about', about).created, true, 'a line of free text, quotes and all, is taken')
})
