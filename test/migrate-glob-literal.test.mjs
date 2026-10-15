// test/migrate-glob-literal.test.mjs — the one-shot report on stored evidence scopes once brackets turned
// literal in the search glob dialect. Stored scopes are read as they stand; an item whose stored result
// differs from the new-dialect result is drifted (derived `suspect`, re-ruled by its judge); the tool lists
// parts naming a literally bracketed file and escaped-bracket parts with git's old reading, and writes nothing.
//
// Design: docs/DESIGN.md#migration-from-4x.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { checkAnchors, itemId, liveItems, recordJudgement } from '../lib/evidence.mjs'
import { appendProject } from '../lib/ledger.mjs'
import { evidenceItemsPath } from '../lib/store.mjs'
import * as tool from '../tools/migrate-glob-literal.mjs'
import { RETURN, git, itemOf, write } from './harness/evidence-fixture.mjs'

const { plan } = tool
const TOOL = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'migrate-glob-literal.mjs')

// ------------------------------------------------------------------ fixtures

const body = (path) => 'needle ' + path + '\nfiller\n'

/** A repository with one commit holding each path with its needle line. */
function repoOf(t, ...paths) {
  const repo = mkdtempSync(join(tmpdir(), 'agentics-glob-'))
  t.after(() => rmSync(repo, { recursive: true, force: true, maxRetries: 3 }))
  git(repo, 'init', '-q', '.')
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 't'], ['core.autocrlf', 'false'], ['core.ignorecase', 'false']]) git(repo, 'config', k, v)
  for (const p of ['README.md', ...paths]) write(repo, p, body(p))
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'c0')
  return repo
}

/** The stored result the old reading found: each file's needle line. */
const found = (...paths) => paths.map((p) => ({ path: p, text: 'needle ' + p })).sort((a, b) => (a.path < b.path ? -1 : 1))

function entryOf(claim, scope, result, id) {
  const it = itemOf({ from_return: RETURN, kind: 'enumeration', claim, queries: [{ pattern: 'needle', scope, result }] })
  return { kind: 'item', item: { ...it, id: id ?? itemId(it) } }
}

function put(repo, ...entries) {
  const out = appendProject(repo, 'items', entries)
  assert.equal(out.ok, true, out.error)
  return entries.map((e) => e.item && e.item.id)
}

const rawOf = (repo) => readFileSync(evidenceItemsPath(repo), 'utf8')

function cli(repo, ...flags) {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  return spawnSync(process.execPath, [TOOL, '--repo', repo, ...flags], { encoding: 'utf8', env })
}

/** A repository whose one item reads `src/[ab].ts`, stored when the class matched src/a.ts and src/b.ts. */
function classFixture(t) {
  const repo = repoOf(t, 'src/a.ts', 'src/b.ts')
  const [id] = put(repo, entryOf('class scope', ['src/[ab].ts'], found('src/a.ts', 'src/b.ts')))
  return { repo, id }
}

// ------------------------------------------------------------------ G1: drift is reported, never written

test('a class scope that now reads literally is drifted', (t) => {
  const { repo, id } = classFixture(t)
  const p = plan(repo)
  assert.equal(p.drifted.length, 1, JSON.stringify(p))
  const [d] = p.drifted
  assert.equal(d.id, id)
  assert.equal(d.claim, 'class scope')
  assert.equal(d.query, 0)
  assert.equal(d.now, '')
  assert.match(d.old, /src\/a\.ts/)
})

test('the drift flag survives the run', (t) => {
  const { repo, id } = classFixture(t)
  assert.equal(cli(repo).status, 0)
  const st = checkAnchors(repo, [id])[0]
  assert.equal(st.state, 'suspect', st.why)
  assert.ok(st.changed.some((c) => c.anchor === 'query' && c.index === 0))
})

test('the tool writes nothing', (t) => {
  const { repo } = classFixture(t)
  const before = rawOf(repo)
  for (const flags of [[], ['--yes'], ['--other']]) {
    cli(repo, ...flags)
    assert.equal(rawOf(repo), before, 'after ' + JSON.stringify(flags))
  }
  plan(repo)
  assert.equal(rawOf(repo), before, 'after plan')
})

test('an unchanged query is standing', (t) => {
  const repo = repoOf(t, 'src/a.ts', 'a/b.ts')
  put(repo, entryOf('globbed', ['src/**', 'a/b.ts'], found('src/a.ts', 'a/b.ts')))
  const p = plan(repo)
  assert.deepEqual(p.drifted, [])
  assert.equal(p.standing, 1)
})

test("a judge's holds records the fresh result", (t) => {
  const { repo, id } = classFixture(t)
  assert.equal(plan(repo).drifted.length, 1)
  const out = recordJudgement(repo, id, 'holds')
  assert.equal(out.ok, true, JSON.stringify(out))
  const p = plan(repo)
  assert.deepEqual(p.drifted, [])
  assert.equal(p.standing, 1)
  assert.deepEqual(liveItems(repo).get(id).queries[0].result, [])
})

test('only the latest revision is read', (t) => {
  const repo = repoOf(t, 'src/a.ts', 'src/b.ts', 'src/[ab].ts')
  const [id] = put(repo, entryOf('revised', ['src/[ab].ts', 'src/\\[a].ts'], found('src/a.ts', 'src/b.ts')))
  put(repo, entryOf('revised', ['src/**'], found('src/[ab].ts', 'src/a.ts', 'src/b.ts'), id))
  const p = plan(repo)
  assert.deepEqual(p.drifted, [])
  assert.deepEqual(p.bracketed, [], 'the older scope is not read')
  assert.deepEqual(p.escaped, [], 'the older scope is not read')
  assert.equal(p.standing, 1)
})

// ------------------------------------------------------------------ G2: literally bracketed files

test('a part naming a bracketed file is listed', (t) => {
  const repo = repoOf(t, 'src/[ab].ts', 'src/a.ts', 'src/b.ts')
  const [id] = put(repo, entryOf('bracketed', ['src/[ab].ts'], found('src/a.ts', 'src/b.ts')))
  const p = plan(repo)
  assert.deepEqual(p.bracketed, [{ id, claim: 'bracketed', query: 0, part: 'src/[ab].ts', file: 'src/[ab].ts' }])
})

test('a class part with no such file is not listed as bracketed', (t) => {
  const { repo } = classFixture(t)
  assert.deepEqual(plan(repo).bracketed, [])
})

// ------------------------------------------------------------------ G3: escaped brackets

test("an escaped bracket is listed with git's old reading", (t) => {
  const repo = repoOf(t, 'src/x.ts', 'src/[x].ts')
  const part = 'src/\\[x].ts'
  const [id] = put(repo, entryOf('escaped', [part], found('src/[x].ts')))
  const oracle = execFileSync('git', ['-C', repo, 'ls-files', '-z', '--', part], { encoding: 'utf8' }).split('\0').filter(Boolean).sort()
  const p = plan(repo)
  assert.deepEqual(p.escaped, [{ id, claim: 'escaped', query: 0, part, read: oracle }])
})

test('a part without an escape is not listed as escaped', (t) => {
  const { repo } = classFixture(t)
  assert.deepEqual(plan(repo).escaped, [])
})

// ------------------------------------------------------------------ G4: CLI shape and edges

test('a malformed scope is listed and fails the run', (t) => {
  const { repo } = classFixture(t)
  const [id] = put(repo, entryOf('string scope', 'src/a.ts', []))
  const p = plan(repo)
  assert.equal(p.malformed.length, 1, JSON.stringify(p.malformed))
  assert.equal(p.malformed[0].id, id)
  const r = cli(repo)
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.ok(r.stdout.split('\n').some((l) => /malformed/.test(l) && l.includes(id)), r.stdout)
})

test('drift alone exits 0', (t) => {
  const { repo, id } = classFixture(t)
  const r = cli(repo)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.ok(r.stdout.split('\n').some((l) => /drifted/.test(l) && l.includes(id) && l.includes('class scope')), r.stdout)
})

test('an empty store is fine', (t) => {
  const repo = repoOf(t)
  assert.deepEqual(plan(repo), { drifted: [], bracketed: [], escaped: [], malformed: [], standing: 0 })
  const r = cli(repo)
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

test('run from a worktree reads the main store', (t) => {
  const { repo, id } = classFixture(t)
  const wt = join(mkdtempSync(join(tmpdir(), 'agentics-glob-wt-')), 'wt')
  t.after(() => rmSync(dirname(wt), { recursive: true, force: true, maxRetries: 3 }))
  git(repo, 'worktree', 'add', '-q', '-b', 'side', wt)
  write(repo, 'src/[ab].ts', body('src/[ab].ts'))
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'main only')
  const p = plan(wt)
  assert.deepEqual(p.drifted.map((d) => d.id), [id])
  assert.deepEqual(p.bracketed.map((b) => b.file), ['src/[ab].ts'], 'the files are the main checkout\'s')
  assert.equal(existsSync(join(wt, '.agentics')), false, 'the worktree gained no store of its own')
})

test('a line the tool cannot read is listed', (t) => {
  const { repo, id } = classFixture(t)
  appendFileSync(evidenceItemsPath(repo), 'not json {{\n', 'utf8')
  const p = plan(repo)
  assert.equal(p.malformed.length, 1, JSON.stringify(p.malformed))
  assert.equal(p.malformed[0].line, 2)
  assert.deepEqual(p.drifted.map((d) => d.id), [id], 'the run goes on past the line')
})

test('there is nothing to apply', (t) => {
  assert.equal('apply' in tool, false)
  const { repo } = classFixture(t)
  const r = cli(repo, '--yes')
  assert.equal(r.status, 2)
  assert.match(r.stdout + r.stderr, /writes nothing/)
})
