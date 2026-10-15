// test/migrate-glob-literal.test.mjs — the one-shot that keeps stored evidence scopes meaning what they meant
// when brackets turned literal in the search glob dialect (N19).
//
// A stored query scope part holding a character class is rewritten into literal parts: a positive class
// into one part per character, a negated or POSIX class into the concrete segment values the old pattern
// matched among the files at the item's anchor commit (HEAD when the anchor is gone). git's own `:(glob)`
// pathspec is the reference for the old meaning: every expected set below that is not a spec golden is
// computed from it. An item's anchor commit is the `at` of its spans (and of its latest judgement); the
// fixtures set both to the same commit, and an item with no anchor reads HEAD.
//
// Design: docs/DESIGN.md#migration-from-4x.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { checkAnchors, itemId, liveItems } from '../lib/evidence.mjs'
import { appendProject, readProjectLog } from '../lib/ledger.mjs'
import { within } from '../lib/search/query.mjs'
import { evidenceItemsPath } from '../lib/store.mjs'
import { apply, plan } from '../tools/migrate-glob-literal.mjs'
import { RETURN, git, itemOf, write } from './harness/evidence-fixture.mjs'

const TOOL = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'migrate-glob-literal.mjs')
const GONE = 'f'.repeat(40)

// ------------------------------------------------------------------ repositories

/** A repository whose commits hold `trees` in order; a tree maps a path to its text, or to null to delete it. */
function history(t, trees) {
  const repo = mkdtempSync(join(tmpdir(), 'agentics-glob-'))
  t.after(() => rmSync(repo, { recursive: true, force: true, maxRetries: 3 }))
  git(repo, 'init', '-q', '.')
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 't'], ['core.autocrlf', 'false'], ['core.ignorecase', 'false']]) git(repo, 'config', k, v)
  const shas = []
  for (const tree of trees) {
    for (const [path, content] of Object.entries(tree)) {
      if (content === null) rmSync(join(repo, ...path.split('/')), { force: true })
      else write(repo, path, content)
    }
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'c' + shas.length)
    shas.push(git(repo, 'rev-parse', 'HEAD'))
  }
  return { repo, shas }
}

const body = (path) => 'needle ' + path + '\nfiller\n'
const tree = (...paths) => Object.fromEntries(paths.map((p) => [p, body(p)]))
const bare = (t) => history(t, [tree('README.md')]).repo

/** A throwaway repository's index holding src/<c>.ts for every printable ASCII c but `/` and `\`: git's glob matcher over them. */
function universe(t) {
  const dir = mkdtempSync(join(tmpdir(), 'agentics-glob-universe-'))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }))
  git(dir, 'init', '-q', '.')
  git(dir, 'config', 'core.ignorecase', 'false')
  const blob = execFileSync('git', ['-C', dir, 'hash-object', '-w', '--stdin'], { input: '', encoding: 'utf8' }).trim()
  const names = []
  for (let c = 0x21; c <= 0x7e; c++) if (c !== 0x2f && c !== 0x5c) names.push('src/' + String.fromCharCode(c) + '.ts')
  execFileSync('git', ['-C', dir, 'update-index', '--add', '--index-info'], { input: names.map((n) => '100644 ' + blob + '\t' + n).join('\n') + '\n' })
  return (pattern) => execFileSync('git', ['-C', dir, 'ls-files', '-z', '--', ':(glob)' + pattern], { encoding: 'utf8' }).split('\0').filter(Boolean)
}

const filesAt = (repo, rev) => git(repo, 'ls-tree', '-r', '--name-only', rev).split('\n').filter(Boolean)

/** The files of `rev` the old reading of `parts` (git's `:(glob)`) matched. */
function oldFiles(repo, rev, parts) {
  const r = spawnSync('git', ['-C', repo, 'grep', '-l', '-e', 'needle', rev, '--', ...parts.map((p) => ':(glob)' + p)], { encoding: 'utf8' })
  if (r.status === 1) return []
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.split('\n').filter(Boolean).map((l) => l.slice(rev.length + 1)).sort()
}

/** The files of `rev` the new dialect's reading of `parts` matches. */
const newFiles = (repo, rev, parts) => filesAt(repo, rev).filter((f) => parts.some((p) => within(f, p))).sort()

/** The `{path, text}` set the old reading of `parts` found in the working tree. */
function oldResult(repo, parts) {
  const r = spawnSync('git', ['-C', repo, 'grep', '-I', '-e', 'needle', '--', ...parts.map((p) => ':(glob)' + p)], { encoding: 'utf8' })
  if (r.status === 1) return []
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.split('\n').filter(Boolean).map((l) => ({ path: l.slice(0, l.indexOf(':')), text: l.slice(l.indexOf(':') + 1) }))
}

// ------------------------------------------------------------------ the store

const query = (scope, pattern = 'needle', result = []) => ({ pattern, scope, result })
const itemEntry = (item) => {
  const it = itemOf({ from_return: RETURN, ...item })
  return { kind: 'item', item: { ...it, id: itemId(it) } }
}
const enumeration = (claim, scope, extra = {}) => itemEntry({ kind: 'enumeration', claim, queries: [query(scope)], ...extra })

/** A relation item whose span, and latest judgement, are anchored at `sha`. */
function anchored(claim, scope, path, sha, extra = {}) {
  const e = itemEntry({ kind: 'relation', claim, spans: [{ path, start: 1, end: 1, at: sha }], queries: [query(scope)], ...extra })
  return [e, { kind: 'judged', id: e.item.id, ruling: 'holds', at: sha }]
}

function put(repo, ...entries) {
  const out = appendProject(repo, 'items', entries.flat())
  assert.equal(out.ok, true, out.error)
}

const itemsFile = (repo) => evidenceItemsPath(repo)
const rawOf = (repo) => readFileSync(itemsFile(repo), 'utf8')
const entriesOf = (repo) => readProjectLog(repo, 'items').entries
const liveOf = (repo, claim) => [...liveItems(repo).values()].find((i) => i.claim === claim)
const scopeOf = (repo, claim, q = 0) => liveOf(repo, claim).queries[q].scope

/** The entries with every query scope sorted, so the order of a scope's parts is not compared. */
const norm = (entries) => entries.map((e) => (e.kind !== 'item' ? e : {
  ...e, item: { ...e.item, queries: e.item.queries.map((q) => ({ ...q, scope: Array.isArray(q.scope) ? [...q.scope].sort() : q.scope })) },
}))

/** The entries with every list scope `fn` rewrites replaced. */
const withScopes = (entries, fn) => entries.map((e) => (e.kind !== 'item' ? e : {
  ...e, item: { ...e.item, queries: e.item.queries.map((q) => (Array.isArray(q.scope) ? { ...q, scope: fn(q.scope) ?? q.scope } : q)) },
}))

/** Every file under `dir` with its bytes. */
function snapshot(dir) {
  const out = {}
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out[relative(dir, p).split(sep).join('/')] = readFileSync(p).toString('base64')
    }
  }
  if (existsSync(dir)) walk(dir)
  return out
}
const agentics = (repo) => join(repo, '.agentics')

// ------------------------------------------------------------------ running the tool

function cli(repo, ...flags) {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  return spawnSync(process.execPath, [TOOL, '--repo', repo, ...flags], { encoding: 'utf8', env })
}
function migrate(repo) {
  const r = cli(repo, '--yes')
  assert.equal(r.status, 0, r.stdout + r.stderr)
  return r
}

function planned(repo, before) {
  const p = plan(repo)
  const hit = p.items.filter((i) => JSON.stringify(i.before) === JSON.stringify(before))
  assert.equal(hit.length, 1, 'one plan item for ' + JSON.stringify(before) + ' among ' + JSON.stringify(p.items))
  return hit[0]
}

/** `actual` holds exactly the parts of `expected`, each once, in any order. */
function parts(actual, expected, why) {
  assert.ok(Array.isArray(actual), why + ': not a list: ' + JSON.stringify(actual))
  assert.deepEqual([...actual].sort(), [...expected].sort(), why)
  assert.equal(new Set(actual).size, actual.length, why + ': a part repeats in ' + JSON.stringify(actual))
}

// ------------------------------------------------------------------ the tests

test('dry run writes nothing', (t) => {
  const { repo, shas } = history(t, [tree('src/a.ts', 'src/b.ts', 'app/a/one.ts', 'app/x/two.ts')])
  put(repo, enumeration('plain class', ['src/[ab].ts']), anchored('negated class', ['app/[!x]/*.ts'], 'app/a/one.ts', shas[0]))
  const before = snapshot(agentics(repo))
  assert.ok(Object.keys(before).length > 0)

  const r = cli(repo)
  assert.equal(r.error, undefined)
  assert.equal(r.signal, null)
  for (const shown of ['src/[ab].ts', 'src/a.ts', 'src/b.ts', 'app/[!x]/*.ts', 'app/a/*.ts']) {
    assert.ok(r.stdout.includes(shown), 'the dry run lists ' + shown + ':\n' + r.stdout + r.stderr)
  }
  assert.deepEqual(snapshot(agentics(repo)), before, 'the dry run left the store as it was')

  const p = plan(repo)
  assert.equal(p.items.length, 2)
  assert.deepEqual(snapshot(agentics(repo)), before, 'planning writes nothing either')
})

test('a positive class expands to literal parts', (t) => {
  const { repo } = history(t, [tree('src/a.ts', 'src/b.ts', 'src/c.ts')])
  put(repo, enumeration('two files', ['src/[ab].ts']))
  const p = planned(repo, ['src/[ab].ts'])
  parts(p.after, ['src/a.ts', 'src/b.ts'], 'the plan')
  assert.equal(plan(repo).unchanged, 0)
  migrate(repo)
  parts(scopeOf(repo, 'two files'), ['src/a.ts', 'src/b.ts'], 'the store')
})

test('a range expands', (t) => {
  const repo = bare(t)
  put(repo, enumeration('letters', ['src/[a-c].ts']), enumeration('digits', ['src/[1-3].ts']))
  parts(planned(repo, ['src/[a-c].ts']).after, ['src/a.ts', 'src/b.ts', 'src/c.ts'], 'letters in the plan')
  parts(planned(repo, ['src/[1-3].ts']).after, ['src/1.ts', 'src/2.ts', 'src/3.ts'], 'digits in the plan')
  migrate(repo)
  parts(scopeOf(repo, 'letters'), ['src/a.ts', 'src/b.ts', 'src/c.ts'], 'letters in the store')
  parts(scopeOf(repo, 'digits'), ['src/1.ts', 'src/2.ts', 'src/3.ts'], 'digits in the store')
})

test('positive classes expand to exactly what git glob matching accepts', (t) => {
  const repo = bare(t)
  const matched = universe(t)
  const classes = ['[ab]', '[aab]', '[a-cx]', '[0-9]', '[-ab]', '[ab-]', '[A-C]', '[a-c0-2_]', '[]a]', '[a[]']
  put(repo, ...classes.map((c) => enumeration('class ' + c, ['src/' + c + '.ts'])))
  const p = plan(repo)
  for (const c of classes) {
    const want = matched('src/' + c + '.ts')
    assert.ok(want.length >= 2, c + ' holds characters, or this case shows nothing')
    const hit = p.items.filter((i) => JSON.stringify(i.before) === JSON.stringify(['src/' + c + '.ts']))
    assert.equal(hit.length, 1, c)
    parts(hit[0].after, want, c)
  }
})

test('a negated class resolves against the anchor', (t) => {
  const { repo, shas } = history(t, [tree('app/a/one.ts', 'app/x/two.ts'), tree('app/b/three.ts')])
  put(
    repo,
    anchored('bang', ['app/[!x]/*.ts'], 'app/a/one.ts', shas[0]),
    anchored('caret', ['app/[^x]/*.ts'], 'app/a/one.ts', shas[0]),
  )
  parts(planned(repo, ['app/[!x]/*.ts']).after, ['app/a/*.ts'], 'bang in the plan')
  parts(planned(repo, ['app/[^x]/*.ts']).after, ['app/a/*.ts'], 'caret in the plan')
  migrate(repo)
  parts(scopeOf(repo, 'bang'), ['app/a/*.ts'], 'bang in the store')
  parts(scopeOf(repo, 'caret'), ['app/a/*.ts'], 'caret in the store')
})

test('a gone anchor falls back to HEAD', (t) => {
  const { repo, shas } = history(t, [tree('app/a/one.ts', 'app/x/two.ts'), tree('app/b/three.ts')])
  assert.notEqual(shas[0], GONE)
  put(
    repo,
    anchored('anchor gone', ['app/[!x]/*.ts'], 'app/a/one.ts', GONE),
    enumeration('no anchor', ['app/[^x]/*.ts']),
  )
  const both = ['app/a/*.ts', 'app/b/*.ts']
  parts(planned(repo, ['app/[!x]/*.ts']).after, both, 'a gone anchor in the plan')
  parts(planned(repo, ['app/[^x]/*.ts']).after, both, 'no anchor in the plan')
  migrate(repo)
  parts(scopeOf(repo, 'anchor gone'), both, 'a gone anchor in the store')
  parts(scopeOf(repo, 'no anchor'), both, 'no anchor in the store')
})

test('a class of a bracket', (t) => {
  const { repo } = history(t, [tree('src/b.ts', 'src/].ts')])
  put(
    repo,
    enumeration('only bracket', ['src/[]].ts']),
    enumeration('bracket and a', ['src/[]a].ts']),
    enumeration('class then bracket', ['src/[a]].ts']),
    enumeration('open bracket', ['src/[[].ts']),
    enumeration('negated bracket', ['src/[!]].ts']),
  )
  parts(planned(repo, ['src/[]].ts']).after, ['src/].ts'], 'a class of ] alone')
  parts(planned(repo, ['src/[]a].ts']).after, ['src/].ts', 'src/a.ts'], 'a class of ] and a')
  parts(planned(repo, ['src/[a]].ts']).after, ['src/a].ts'], 'a class of a, then a literal ]')
  parts(planned(repo, ['src/[[].ts']).after, ['src/[.ts'], 'a class of [')
  parts(planned(repo, ['src/[!]].ts']).after, ['src/b.ts'], 'a negated class of ]')
  migrate(repo)
  assert.deepEqual(plan(repo).items, [], 'what the migration wrote holds no class, even where it holds a bracket')
})

test('a POSIX class resolves against the anchor', (t) => {
  const { repo, shas } = history(t, [tree('src/1.ts', 'src/a.ts'), tree('src/2.ts')])
  put(
    repo,
    anchored('digit', ['src/[[:digit:]].ts'], 'src/a.ts', shas[0]),
    anchored('alpha', ['src/[[:alpha:]].ts'], 'src/a.ts', shas[0]),
    anchored('digit or a', ['src/[[:digit:]a].ts'], 'src/a.ts', shas[0]),
  )
  parts(planned(repo, ['src/[[:digit:]].ts']).after, ['src/1.ts'], 'digit in the plan')
  parts(planned(repo, ['src/[[:alpha:]].ts']).after, ['src/a.ts'], 'alpha in the plan')
  parts(planned(repo, ['src/[[:digit:]a].ts']).after, ['src/1.ts', 'src/a.ts'], 'digit or a in the plan')
  migrate(repo)
  parts(scopeOf(repo, 'digit'), ['src/1.ts'], 'digit in the store')
  parts(scopeOf(repo, 'alpha'), ['src/a.ts'], 'alpha in the store')
  parts(scopeOf(repo, 'digit or a'), ['src/1.ts', 'src/a.ts'], 'digit or a in the store')
})

test('negated and POSIX classes keep the old meaning at the anchor', (t) => {
  const first = tree(
    'src/1.ts', 'src/a.ts', 'src/B.ts', 'src/x.ts', 'src/].ts',
    'app/a/one.ts', 'app/b/two.ts', 'app/x/three.ts', 'app/a/note.md',
    'lib/a/f.ts', 'lib/deep/a/f.ts', 'lib/deep/b/f.ts', 'lib/x/f.ts', 'lib/deep/x/f.ts',
    'lib/p/q/f.ts', 'lib/s/r/f.ts', 'lib/x/q/f.ts', 'lib/p/x/f.ts',
  )
  const second = { ...tree('src/z.ts', 'app/c/four.ts', 'lib/deep/c/f.ts'), 'src/a.ts': null, 'app/b/two.ts': null }
  const { repo, shas } = history(t, [first, second])
  const scopes = [
    ['src/[!a].ts'], ['src/[^a].ts'], ['src/[!]].ts'], ['src/[[:digit:]].ts'], ['src/[[:upper:]].ts'], ['src/[[:alnum:]_].ts'],
    ['src/[![:digit:]].ts'], ['app/[!x]/*.ts'], ['app/[[:lower:]]/*.ts'], ['lib/**/[!x]/f.ts'], ['lib/*/[!x]/f.ts'],
    ['lib/[!x]/[!x]/f.ts'],
  ]
  put(repo, ...scopes.map((s) => anchored(JSON.stringify(s), s, 'src/x.ts', shas[0])))
  const p = plan(repo)
  for (const scope of scopes) {
    const hit = p.items.filter((i) => JSON.stringify(i.before) === JSON.stringify(scope))
    assert.equal(hit.length, 1, JSON.stringify(scope))
    const want = oldFiles(repo, shas[0], scope)
    assert.ok(want.length > 0, JSON.stringify(scope) + ' matched files at the anchor, or this case shows nothing')
    assert.deepEqual(newFiles(repo, shas[0], hit[0].after), want, JSON.stringify(scope) + ' → ' + JSON.stringify(hit[0].after))
    for (const part of hit[0].after) assert.ok(!/\[[^\]]*\]/.test(part), part + ' still holds a class') // a lone `]` is a literal name
  }
})

test('a part for a since-deleted file is kept', (t) => {
  const { repo, shas } = history(t, [
    tree('src/a.ts', 'src/b.ts', 'app/a/one.ts', 'app/b/two.ts', 'app/x/three.ts'),
    { 'src/b.ts': null, 'app/b/two.ts': null },
  ])
  put(
    repo,
    anchored('anchored plain', ['src/[ab].ts'], 'src/a.ts', shas[0]),
    enumeration('head plain', ['src/[bc].ts']),
    anchored('anchored negated', ['app/[!x]/*.ts'], 'app/a/one.ts', shas[0]),
  )
  migrate(repo)
  parts(scopeOf(repo, 'anchored plain'), ['src/a.ts', 'src/b.ts'], 'a positive class at the anchor')
  parts(scopeOf(repo, 'head plain'), ['src/b.ts', 'src/c.ts'], 'a positive class holds its characters whatever HEAD has')
  parts(scopeOf(repo, 'anchored negated'), ['app/a/*.ts', 'app/b/*.ts'], 'a negated class reproduces the anchor')
})

test('escaped and unclosed brackets are kept', (t) => {
  const repo = bare(t)
  put(repo, enumeration('escaped', ['src/\\[x].ts']), enumeration('unclosed', ['src/[x.ts']))
  const before = rawOf(repo)
  const p = plan(repo)
  assert.deepEqual(p.items, [])
  assert.equal(p.unchanged, 2)
  migrate(repo)
  assert.equal(rawOf(repo), before)

  put(
    repo,
    enumeration('escaped beside a class', ['src/\\[x].ts', 'src/[ab].ts']),
    enumeration('unclosed beside a class', ['src/[x.ts', 'src/[ab].ts']),
    enumeration('escape then class', ['src/\\[x][ab].ts']),
  )
  migrate(repo)
  parts(scopeOf(repo, 'escaped beside a class'), ['src/\\[x].ts', 'src/a.ts', 'src/b.ts'], 'an escaped part beside a class part')
  parts(scopeOf(repo, 'unclosed beside a class'), ['src/[x.ts', 'src/a.ts', 'src/b.ts'], 'an unclosed part beside a class part')
  parts(scopeOf(repo, 'escape then class'), ['src/\\[x]a.ts', 'src/\\[x]b.ts'], 'a class after an escaped bracket')
  parts(scopeOf(repo, 'escaped'), ['src/\\[x].ts'], 'the escaped scope')
  parts(scopeOf(repo, 'unclosed'), ['src/[x.ts'], 'the unclosed scope')
})

test('a class beside a wildcard keeps the wildcard', (t) => {
  const repo = bare(t)
  const cases = {
    'src/a[bc]*.ts': ['src/ab*.ts', 'src/ac*.ts'],
    'src/**/[ab].ts': ['src/**/a.ts', 'src/**/b.ts'],
    'src/?[ab].ts': ['src/?a.ts', 'src/?b.ts'],
    '[ab]/x.ts': ['a/x.ts', 'b/x.ts'],
    'src/[ab]/**': ['src/a/**', 'src/b/**'],
    '**/[ab].ts': ['**/a.ts', '**/b.ts'],
  }
  put(repo, ...Object.keys(cases).map((s) => enumeration('wild ' + s, [s])))
  for (const [scope, want] of Object.entries(cases)) parts(planned(repo, [scope]).after, want, scope + ' in the plan')
  migrate(repo)
  for (const [scope, want] of Object.entries(cases)) parts(scopeOf(repo, 'wild ' + scope), want, scope + ' in the store')
})

test('two classes in one part expand to every combination', (t) => {
  const repo = bare(t)
  put(repo, enumeration('same segment', ['src/[ab][cd].ts']), enumeration('two segments', ['[ab]/[cd].ts']))
  parts(planned(repo, ['src/[ab][cd].ts']).after, ['src/ac.ts', 'src/ad.ts', 'src/bc.ts', 'src/bd.ts'], 'one segment')
  parts(planned(repo, ['[ab]/[cd].ts']).after, ['a/c.ts', 'a/d.ts', 'b/c.ts', 'b/d.ts'], 'two segments')
})

test('scopes without a class are kept', (t) => {
  const repo = bare(t)
  const scopes = ['src/**', 'a/b.ts', 'src/*.ts', 'src/{a,b}.ts', 'src/a].ts', 'src/a!b^c.ts', '.']
  put(repo, ...scopes.map((s) => enumeration('plain ' + s, [s])))
  const before = rawOf(repo)
  const p = plan(repo)
  assert.deepEqual(p.items, [])
  assert.equal(p.unchanged, scopes.length)
  migrate(repo)
  assert.equal(rawOf(repo), before)

  put(repo, enumeration('one class', ['src/[ab].ts']))
  const mixed = plan(repo)
  assert.equal(mixed.items.length, 1)
  assert.equal(mixed.unchanged, scopes.length)
})

test('the migration is idempotent', (t) => {
  const { repo, shas } = history(t, [tree('src/a.ts', 'src/b.ts', 'app/a/one.ts', 'app/x/two.ts'), tree('app/b/three.ts')])
  put(
    repo,
    enumeration('positive', ['src/[ab].ts', 'src/[[].ts']),
    anchored('negated', ['app/[!x]/*.ts'], 'app/a/one.ts', shas[0]),
    enumeration('plain', ['src/**']),
  )
  const stale = plan(repo)
  migrate(repo)
  const once = snapshot(agentics(repo))
  assert.deepEqual(plan(repo).items, [], 'nothing is left to migrate')
  migrate(repo)
  assert.deepEqual(snapshot(agentics(repo)), once, 'the second run leaves the store as the first left it')
  apply(stale)
  assert.deepEqual(snapshot(agentics(repo)), once, 'a plan made before the first run, applied after it, changes nothing')
  assert.deepEqual(Object.keys(once).filter((k) => k.endsWith('.tmp')), [], 'no staged file is left behind')
})

test('the meaning is kept', (t) => {
  const { repo } = history(t, [tree(
    'src/a.ts', 'src/b.ts', 'src/c.ts', 'src/1.ts', 'src/x.ts',
    'app/a/one.ts', 'app/b/two.ts', 'app/x/three.ts', 'app/a/note.md',
    'lib/a/f.ts', 'lib/deep/a/f.ts', 'lib/deep/b/f.ts', 'lib/x/f.ts', 'lib/deep/x/f.ts',
  )])
  const scopes = [
    ['src/[ab].ts'], ['src/[a-c].ts'], ['src/[!a].ts'], ['src/[^a].ts'], ['src/[[:digit:]].ts'], ['src/[[:alpha:]].ts'],
    ['app/[!x]/*.ts'], ['lib/**/[!x]/f.ts'], ['src/[ab].ts', 'app/x/*.ts'], ['src/[ab].ts', 'src/[bc].ts'],
  ]
  const entries = scopes.map((s) => {
    const result = oldResult(repo, s)
    assert.ok(result.length > 0, JSON.stringify(s) + ' found lines under the old reading, or this case shows nothing')
    return enumeration(JSON.stringify(s), s, { queries: [query(s, 'needle', result)] })
  })
  put(repo, ...entries)
  const ids = entries.map((e) => e.item.id)
  for (const [i, c] of checkAnchors(repo, ids).entries()) {
    assert.equal(c.state, 'suspect', JSON.stringify(scopes[i]) + ' reads differently under the new dialect before the migration')
  }
  migrate(repo)
  for (const [i, c] of checkAnchors(repo, ids).entries()) {
    assert.equal(c.state, 'standing', JSON.stringify(scopes[i]) + ' → ' + JSON.stringify(scopeOf(repo, JSON.stringify(scopes[i]))) + ': ' + JSON.stringify(c.changed))
  }
})

test('a class matching no file at the anchor never widens the scope', (t) => {
  const { repo } = history(t, [tree('app/x/two.ts', 'docs/readme.md')])
  const a = enumeration('nothing matched', ['app/[!x]/*.ts'], { kind: 'absence' })
  const b = enumeration('nothing matched beside another part', ['app/[^x]/*.ts', 'docs/**'], {
    queries: [query(['app/[^x]/*.ts', 'docs/**'], 'needle', oldResult(repo, ['docs/**']))],
  })
  put(repo, a, b)
  assert.equal(checkAnchors(repo, [a.item.id, b.item.id]).every((c) => c.state === 'standing'), true, 'the premise: both stand before')
  migrate(repo)
  assert.ok(scopeOf(repo, 'nothing matched').length > 0, 'an empty scope searches the whole repository')
  for (const c of checkAnchors(repo, [a.item.id, b.item.id])) assert.equal(c.state, 'standing', JSON.stringify(c))
})

test('an empty store is fine', (t) => {
  const bareRepo = bare(t)
  assert.deepEqual(plan(bareRepo).items, [])
  assert.equal(plan(bareRepo).unchanged, 0)
  for (const flags of [[], ['--yes']]) {
    const r = cli(bareRepo, ...flags)
    assert.equal(r.status, 0, r.stdout + r.stderr)
  }

  const { repo, shas } = history(t, [tree('src/a.ts')])
  put(repo, itemEntry({ kind: 'behaviour', claim: 'a span only', spans: [{ path: 'src/a.ts', start: 1, end: 1, at: shas[0] }] }))
  put(repo, { kind: 'judged', id: 'I00000000', ruling: 'holds', at: shas[0] })
  const before = rawOf(repo)
  assert.deepEqual(plan(repo).items, [])
  assert.equal(cli(repo).status, 0)
  assert.equal(migrate(repo).status, 0)
  assert.equal(rawOf(repo), before, 'a store with nothing to migrate is left as it is')
})

test('a torn run reruns cleanly', (t) => {
  const { repo } = history(t, [tree('src/a.ts', 'src/b.ts')])
  put(repo, enumeration('torn', ['src/[ab].ts']))
  const before = snapshot(agentics(repo))
  const killed = plan(repo)
  assert.equal(killed.items.length, 1)
  assert.deepEqual(snapshot(agentics(repo)), before, 'killed after planning, before applying: nothing was written')

  writeFileSync(join(dirname(itemsFile(repo)), 'items.jsonl.4242.tmp'), '{"kind":"item","item":{"id":"I00')
  migrate(repo)
  parts(scopeOf(repo, 'torn'), ['src/a.ts', 'src/b.ts'], 'the rerun applies')
  const raw = rawOf(repo)
  assert.ok(raw.endsWith('\n'))
  for (const line of raw.split('\n').filter(Boolean)) JSON.parse(line)

  apply(killed)
  assert.equal(rawOf(repo), raw, 'the killed run\'s plan, applied late, changes nothing more')
})

test('every stored revision is migrated, in place', (t) => {
  const { repo } = history(t, [tree('src/a.ts', 'src/b.ts')])
  const first = enumeration('revised', ['src/[ab].ts'])
  put(repo, first)
  put(repo, { kind: 'judged', id: first.item.id, ruling: 'holds', at: GONE })
  put(repo, { ...first, item: { ...first.item, queries: [query(['src/[ab].ts'], 'needle', [{ path: 'src/a.ts', text: 'needle src/a.ts' }])] } })
  const before = entriesOf(repo)
  assert.deepEqual(before.map((e) => e.seq), [1, 2, 3])
  migrate(repo)
  const after = entriesOf(repo)
  assert.deepEqual(after.map((e) => [e.seq, e.kind]), before.map((e) => [e.seq, e.kind]), 'every line keeps its seq and its place')
  for (const e of after.filter((x) => x.kind === 'item')) parts(e.item.queries[0].scope, ['src/a.ts', 'src/b.ts'], 'revision at seq ' + e.seq)
  assert.ok(!rawOf(repo).includes('src/[ab].ts'), 'nothing is left in the old dialect')
})

test('nothing but the scopes changes', (t) => {
  const { repo, shas } = history(t, [tree('src/a.ts', 'src/b.ts', 'src/c.ts')])
  const first = enumeration('the scope src/[ab].ts holds', ['src/[ab].ts'], {
    ground: ['src/[ab]'],
    queries: [query(['src/[ab].ts'], 'x[ab]+y', [{ path: 'src/a.ts', text: 'see src/[ab].ts' }])],
    detail: { note: '[ab]' },
  })
  const several = enumeration('four queries', [], {
    queries: [query(['docs/**']), query(['src/[ab].ts']), query(['src/x.ts']), query(['src/[a-c].ts'])],
  })
  const span = itemEntry({ kind: 'behaviour', claim: 'a span item', spans: [{ path: 'src/a.ts', start: 1, end: 1, at: shas[0] }] })
  put(repo, first, { kind: 'judged', id: first.item.id, ruling: 'holds', at: shas[0] }, several, span)
  const table = { 'src/[ab].ts': ['src/a.ts', 'src/b.ts'], 'src/[a-c].ts': ['src/a.ts', 'src/b.ts', 'src/c.ts'] }
  const before = entriesOf(repo)
  const want = norm(withScopes(before, (s) => (s.length === 1 ? table[s[0]] : undefined)))
  migrate(repo)
  assert.deepEqual(norm(entriesOf(repo)), want)
})

test('a malformed scope is listed, not rewritten', (t) => {
  const repo = bare(t)
  const odd = (claim, q) => itemEntry({ kind: 'enumeration', claim, queries: [q] })
  put(
    repo,
    odd('string scope', { pattern: 'needle', scope: 'src/[ab].ts', result: [] }),
    odd('object scope', { pattern: 'needle', scope: { 0: 'src/[ab].ts' }, result: [] }),
    odd('null scope', { pattern: 'needle', scope: null, result: [] }),
    odd('no scope', { pattern: 'needle', result: [] }),
    enumeration('good', ['src/[ab].ts']),
  )
  const before = entriesOf(repo)
  const malformed = ['string scope', 'object scope', 'null scope', 'no scope']

  const dry = cli(repo)
  assert.equal(dry.error, undefined)
  assert.equal(dry.signal, null)
  const lines = (dry.stdout + dry.stderr).split('\n')
  for (const claim of malformed) {
    const { id } = before.find((e) => e.item.claim === claim).item
    const named = lines.filter((l) => l.includes(id) || l.includes(claim))
    assert.ok(named.some((l) => /malformed/i.test(l)), claim + ' is listed as malformed by its id or claim:\n' + lines.join('\n'))
  }

  const r = cli(repo, '--yes')
  assert.equal(r.error, undefined)
  assert.equal(r.signal, null)
  const after = entriesOf(repo)
  assert.equal(after.length, before.length)
  for (const claim of malformed) {
    const was = before.find((e) => e.item.claim === claim)
    assert.deepEqual(after.find((e) => e.item.claim === claim), was, claim + ' is left as it was')
  }
  parts(scopeOf(repo, 'good'), ['src/a.ts', 'src/b.ts'], 'a well-formed item beside the malformed ones')
})

test('a line the tool cannot read survives', (t) => {
  const { repo } = history(t, [tree('src/a.ts', 'src/b.ts')])
  put(repo, enumeration('before the noise', ['src/[ab].ts']))
  appendFileSync(itemsFile(repo), 'not json {{\n', 'utf8')
  put(repo, enumeration('after the noise', ['src/[a-b].ts']))
  appendFileSync(itemsFile(repo), '{"kind":"item","item":{"id":"Ideadbeef","quest', 'utf8')
  const before = entriesOf(repo)
  const r = cli(repo, '--yes')
  const raw = rawOf(repo)
  const migrated = scopeOf(repo, 'before the noise').length === 2 && scopeOf(repo, 'after the noise').length === 2
  assert.ok(migrated || r.status !== 0, 'the readable lines are migrated around the noise, or the run says it did not finish')
  assert.ok(raw.includes('not json {{'), 'a line that is not JSON is not dropped')
  assert.ok(raw.includes('{"kind":"item","item":{"id":"Ideadbeef","quest'), 'a torn last line is not dropped')
  const after = entriesOf(repo)
  assert.deepEqual(after.map((e) => [e.seq, e.kind]), before.map((e) => [e.seq, e.kind]), 'the lines it can read keep their seq and their place')
})

test('apply keeps a line appended after the plan', (t) => {
  const { repo } = history(t, [tree('src/a.ts', 'src/b.ts')])
  put(repo, enumeration('early', ['src/[ab].ts']))
  const p = plan(repo)
  put(repo, enumeration('late', ['src/**']), enumeration('late class', ['src/[a-b].ts']))
  const want = norm(withScopes(entriesOf(repo), (s) => (s.length === 1 && s[0] === 'src/[ab].ts' ? ['src/a.ts', 'src/b.ts'] : undefined)))
  apply(p)
  const after = norm(entriesOf(repo))
  assert.equal(after.length, want.length, 'the lines appended after the plan are still there')
  for (const [i, e] of after.entries()) {
    if (e.item && e.item.claim === 'late class') continue
    assert.deepEqual(e, want[i], 'entry ' + i)
  }
  const late = scopeOf(repo, 'late class')
  assert.ok(
    JSON.stringify([...late].sort()) === JSON.stringify(['src/[a-b].ts']) || JSON.stringify([...late].sort()) === JSON.stringify(['src/a.ts', 'src/b.ts']),
    'a class the plan did not see is either left for the next run or migrated whole: ' + JSON.stringify(late),
  )
})

test('run from a worktree migrates the main store', (t) => {
  const { repo } = history(t, [tree('src/a.ts', 'src/b.ts', 'app/a/one.ts', 'app/x/two.ts')])
  const wt = join(mkdtempSync(join(tmpdir(), 'agentics-glob-wt-')), 'wt')
  t.after(() => rmSync(dirname(wt), { recursive: true, force: true, maxRetries: 3 }))
  git(repo, 'worktree', 'add', '-q', '-b', 'side', wt)
  put(repo, enumeration('positive', ['src/[ab].ts']), enumeration('negated', ['app/[!x]/*.ts']))

  assert.equal(plan(wt).items.length, 2)
  migrate(wt)
  parts(scopeOf(repo, 'positive'), ['src/a.ts', 'src/b.ts'], 'the main store, positive')
  parts(scopeOf(repo, 'negated'), ['app/a/*.ts'], 'the main store, negated')
  assert.equal(existsSync(join(wt, '.agentics')), false, 'the worktree gained no store of its own')
  assert.deepEqual(plan(repo).items, [])
})
