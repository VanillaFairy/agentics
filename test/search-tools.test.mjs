// test/search-tools.test.mjs — pins the tools a search's calls run over one pinned tree: every
// path keyed as git prints it, every refusal named, nothing truncated without a next page, and
// the tree's edges — CRLF text, brackets and spaces in a path, an ignored directory a scope names,
// node_modules, a submodule, a nested repository and a linked worktree — each where it belongs.
//
// Design: docs/DESIGN.md#searches.

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { canonicalUrl } from '../lib/search/query.mjs'
import {
  PAGE_LINES, REFUSALS, fetchUrl, files, grep, isTestKey, keyOf, log, read, refs, show,
} from '../lib/search/tools.mjs'

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: ENV, windowsHide: true }).trim()
const put = (root, path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text) }

const ROWS = 2 * PAGE_LINES + 5
/**
 * The fixture's files: their text, whether the tools reach them over the whole tree (`reach`),
 * and the key they are reached by. `when` says how the file gets there: committed (default),
 * `untracked`, or inside the submodule.
 */
const FILES = {
  'src/a.mjs': { text: 'const NEEDLE_ID = 42\nfoo(NEEDLE_ID)\nconst NEEDLE_IDX = 0\nconst dotted = "a.b axb"\n', reach: true },
  'src/new.mjs': { text: 'NEEDLE_ID untracked 5\n', reach: true, when: 'untracked' },
  'app/[id]/page view.tsx': { text: 'line one\r\nNEEDLE_ID 7\r\nend\r\n', reach: true },
  'test/a.test.mjs': { text: 'NEEDLE_ID\n', reach: true },
  'CLAUDE.md': { text: '# guidance\n', reach: true },
  'src/CLAUDE.md': { text: '# src guidance\n', reach: true },
  'big.txt': { text: Array.from({ length: ROWS }, (_, i) => 'row ' + (i + 1)).join('\n') + '\n', reach: true },
  'bin.dat': { text: 'NEEDLE_ID\0binary\n', reach: false },
  '.gitignore': { text: 'gen/\nnode_modules/\n', reach: true },
  'gen/out.txt': { text: 'NEEDLE_ID gen 1\n', reach: false },
  'node_modules/p/i.js': { text: 'NEEDLE_ID nm 2\n', reach: false },
  '.agentics/runs/r/calls.jsonl': { text: '{"pattern":"NEEDLE_ID"}\n', reach: false, when: 'untracked' },
  // a plain directory under .claude/worktrees (no .git of its own), and names that only look fenced
  '.claude/worktrees/loose/a.ts': { text: 'a loose copy of a file\n', reach: false, when: 'untracked' },
  '.claude/settings.json': { text: '{}\n', reach: true },
  '.agenticsx/a.txt': { text: 'not the store\n', reach: true },
  // the decoys: what reading [id] as a class, or * as crossing a directory, would add
  'app/i/page view.tsx': { text: 'NEEDLE_ID decoy\n', reach: true },
  'src/x/a.mjs': { text: 'NEEDLE_ID one directory down\n', reach: true },
  'nested/x.txt': { text: 'NEEDLE_ID nested 3\n', reach: false, when: 'nested' },
  'vendor/s/lib/s.mjs': { text: 'export const NEEDLE_ID = 1\n', reach: true, when: 'submodule' },
}
const reached = Object.entries(FILES).filter(([, f]) => f.reach && !f.text.includes('\0'))
const linesOf = (text) => text.split(/\r?\n/).slice(0, text.endsWith('\n') ? -1 : undefined)
/** Every (key, line, text) the tree holds that `re` matches, among the files the tools reach. */
const matchesOf = (re, keep = () => true) => reached.filter(([k]) => keep(k))
  .flatMap(([key, f]) => linesOf(f.text).map((text, i) => ({ key, line: i + 1, text })).filter((l) => re.test(l.text)))
  .sort((a, b) => (a.key === b.key ? a.line - b.line : a.key < b.key ? -1 : 1))

let base
let tree
let shas

before(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'agentics-search-tools-')))
  const sub = join(base, 'sub')
  mkdirSync(sub)
  git(sub, 'init', '-q'); git(sub, 'config', 'core.autocrlf', 'false')
  put(sub, 'lib/s.mjs', FILES['vendor/s/lib/s.mjs'].text)
  git(sub, 'add', '-A'); git(sub, 'commit', '-qm', 'sub')
  const root = join(base, 'repo')
  mkdirSync(root)
  git(root, 'init', '-q'); git(root, 'config', 'core.autocrlf', 'false')
  for (const [path, f] of Object.entries(FILES)) if (!f.when && path !== 'app/[id]/page view.tsx') put(root, path, f.text)
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'init')
  put(root, 'app/[id]/page view.tsx', FILES['app/[id]/page view.tsx'].text)
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'add the needle route')
  git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub.split('\\').join('/'), 'vendor/s')
  git(root, 'commit', '-qm', 'vendor the sub')
  git(root, 'switch', '-q', '-c', 'side')
  put(root, 'side.txt', 'a side line\n')
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'a side commit')
  git(root, 'switch', '-q', '-')
  git(root, 'worktree', 'add', '-q', '--detach', '.claude/worktrees/w', 'HEAD')
  const nested = join(root, 'nested')
  mkdirSync(nested)
  git(nested, 'init', '-q')
  for (const [path, f] of Object.entries(FILES)) if (f.when === 'untracked' || f.when === 'nested') put(root, path, f.text)
  tree = { root: root.split('\\').join('/'), sha: git(root, 'rev-parse', 'HEAD') }
  shas = git(root, 'log', '--format=%H').split('\n')
})

after(() => rmSync(base, { recursive: true, force: true }))

/** A refusal, by the class the interface names. */
function refusedAs(out, refusal) {
  assert.equal(out.ok, false, JSON.stringify(out))
  assert.ok(REFUSALS.includes(out.refusal), out.refusal + ' is one of REFUSALS')
  assert.equal(out.refusal, refusal, JSON.stringify(out))
  assert.equal(typeof out.detail, 'string')
  assert.ok(out.detail.length > 0, 'a refusal says why')
}

// ------------------------------------------------------------------ keys

test('a path is keyed as git prints it, however it is spelled', () => {
  const want = { ok: true, key: 'src/a.mjs' }
  assert.deepEqual(keyOf(tree, 'src/a.mjs'), want)
  assert.deepEqual(keyOf(tree, './src/a.mjs'), want)
  assert.deepEqual(keyOf(tree, join(tree.root, 'src', 'a.mjs')), want)
  if (process.platform === 'win32') {
    assert.deepEqual(keyOf(tree, 'src\\a.mjs'), want, 'Windows: a backslashed path')
    assert.deepEqual(keyOf(tree, 'SRC/A.MJS'), want, 'Windows: the true case')
  }
  assert.deepEqual(keyOf(tree, 'app/[id]/page view.tsx'), { ok: true, key: 'app/[id]/page view.tsx' })
})

test('an untracked file is a key', () => {
  assert.deepEqual(keyOf(tree, 'src/new.mjs'), { ok: true, key: 'src/new.mjs' })
})

test('a submodule file is keyed under the submodule', () => {
  assert.deepEqual(keyOf(tree, 'vendor/s/lib/s.mjs'), { ok: true, key: 'vendor/s/lib/s.mjs' })
})

test('what is not a file of this tree is not a key', () => {
  for (const p of ['nope.mjs', 'src', '../outside.txt', '.git/HEAD', 'nested/x.txt', '.claude/worktrees/w/src/a.mjs', '', 'a\0b']) {
    refusedAs(keyOf(tree, p), 'not_canonical')
  }
})

// ------------------------------------------------------------------ grep

test('grep returns every matching line of the tree with its key, line and text', async () => {
  const re = /NEEDLE_ID/
  const out = await grep(tree, { pattern: 'NEEDLE_ID' }, { scope: ['.'] })
  assert.equal(out.ok, true, JSON.stringify(out))
  const want = matchesOf(re)
  assert.deepEqual(out.lines, want)
  assert.equal(out.total, want.length)
  assert.equal(out.files, new Set(want.map((l) => l.key)).size)
  assert.deepEqual([out.page, out.pages], [1, 1])
})

test('grep reaches untracked files and a submodule, and never a nested repository, a worktree, .agentics, a binary or an ignored directory', async () => {
  const keys = new Set((await grep(tree, { pattern: 'NEEDLE_ID' }, { scope: ['.'] })).lines.map((l) => l.key))
  assert.ok(keys.has('src/new.mjs'), 'an untracked file')
  assert.ok(keys.has('vendor/s/lib/s.mjs'), 'a submodule file, keyed under it')
  for (const k of keys) {
    for (const never of ['nested/', '.claude/', '.agentics/', 'gen/', 'node_modules/']) assert.ok(!k.startsWith(never), k)
    assert.notEqual(k, 'bin.dat')
  }
})

test('grep runs the shared dialect: \\d finds digits', async () => {
  const out = await grep(tree, { pattern: 'NEEDLE_ID \\d' }, { scope: ['.'] })
  assert.deepEqual(out.lines, matchesOf(/NEEDLE_ID \d/))
  assert.ok(out.total > 0)
})

test('a CRLF file and a path with brackets and spaces read like any other', async () => {
  const out = await grep(tree, { pattern: 'NEEDLE_ID 7', paths: ['app/[id]/page view.tsx'] }, { scope: ['.'] })
  assert.deepEqual(out.lines, [{ key: 'app/[id]/page view.tsx', line: 2, text: 'NEEDLE_ID 7' }], 'no trailing CR, the path literal')
})

test('fixed and ignore_case are honoured', async () => {
  assert.deepEqual((await grep(tree, { pattern: 'a.b', fixed: true }, { scope: ['src'] })).lines.map((l) => l.text), ['const dotted = "a.b axb"'])
  const loud = await grep(tree, { pattern: 'needle_id', ignore_case: true }, { scope: ['src'] })
  assert.deepEqual(loud.lines, matchesOf(/needle_id/i, (k) => k.startsWith('src/')))
})

test('grep pages its lines and keeps every later page for a later call', async () => {
  const pages = Math.ceil(ROWS / PAGE_LINES)
  const first = await grep(tree, { pattern: '^row' }, { scope: ['big.txt'] })
  assert.deepEqual([first.total, first.files, first.page, first.pages], [ROWS, 1, 1, pages])
  assert.equal(first.lines.length, PAGE_LINES)
  const all = [first]
  for (let p = 2; p <= pages; p++) all.push(await grep(tree, { pattern: '^row', page: p }, { scope: ['big.txt'] }))
  assert.deepEqual(all.flatMap((o) => o.lines), matchesOf(/^row/, (k) => k === 'big.txt'), 'the pages together are the whole result, in order')
  refusedAs(await grep(tree, { pattern: '^row', page: pages + 1 }, { scope: ['big.txt'] }), 'past_eof')
})

test('a grep that matches nothing is one empty page', async () => {
  const out = await grep(tree, { pattern: 'ZZZ_NOWHERE' }, { scope: ['.'] })
  assert.equal(out.ok, true)
  assert.deepEqual([out.total, out.files, out.lines], [0, 0, []])
})

test('grep stays inside its scope and refuses a path outside it', async () => {
  const out = await grep(tree, { pattern: 'NEEDLE_ID' }, { scope: ['src'] })
  assert.ok(out.lines.length > 0 && out.lines.every((l) => l.key.startsWith('src/')))
  refusedAs(await grep(tree, { pattern: 'NEEDLE_ID', paths: ['app'] }, { scope: ['src'] }), 'outside_scope')
})

test('a scope that names an ignored directory reaches into it', async () => {
  assert.deepEqual((await grep(tree, { pattern: 'NEEDLE_ID' }, { scope: ['gen'] })).lines, [{ key: 'gen/out.txt', line: 1, text: 'NEEDLE_ID gen 1' }])
})

test('node_modules is reached only through a scope part that names it', async () => {
  assert.deepEqual((await grep(tree, { pattern: 'NEEDLE_ID' }, { scope: ['node_modules'] })).lines.map((l) => l.key), ['node_modules/p/i.js'])
})

test('grep takes ** glob paths inside its scope, narrowed to it', async () => {
  const mjs = (keep) => matchesOf(/NEEDLE_ID/, (k) => k.endsWith('.mjs') && keep(k))
  assert.deepEqual((await grep(tree, { pattern: 'NEEDLE_ID', paths: ['**/*.mjs'] }, { scope: ['src'] })).lines, mjs((k) => k.startsWith('src/')))
  assert.deepEqual((await grep(tree, { pattern: 'NEEDLE_ID', paths: ['src/**/*.mjs'] }, { scope: ['.'] })).lines, mjs((k) => k.startsWith('src/')))
  const everywhere = await grep(tree, { pattern: 'NEEDLE_ID', paths: ['**/*.mjs'] }, { scope: ['.'] })
  assert.deepEqual(everywhere.lines, mjs(() => true), 'a **/ glob reaches the submodule too')
  refusedAs(await grep(tree, { pattern: 'NEEDLE_ID', paths: ['app/**'] }, { scope: ['src'] }), 'outside_scope')
})

test('grep paths read brackets literally', async () => {
  const route = [{ key: 'app/[id]/page view.tsx', line: 2, text: 'NEEDLE_ID 7' }]
  assert.ok(matchesOf(/NEEDLE_ID/, (k) => k === 'app/i/page view.tsx').length > 0, 'the decoy app/i/ holds the needle too')
  for (const paths of [['app/[id]/*'], ['app/[id]/**'], ['app/[id]'], ['app/[id]/page view.tsx']]) {
    const out = await grep(tree, { pattern: 'NEEDLE_ID', paths }, { scope: ['.'] })
    assert.deepEqual(out.lines, route, JSON.stringify(paths) + ': a class reading would add app/i/')
  }
})

test('grep path globs keep star in its segment', async () => {
  const flat = matchesOf(/NEEDLE_ID/, (k) => /^src\/[^/]+\.mjs$/.test(k))
  assert.ok(flat.length > 0)
  const out = await grep(tree, { pattern: 'NEEDLE_ID', paths: ['src/*.mjs'] }, { scope: ['.'] })
  assert.deepEqual(out.lines, flat)
  assert.ok(!out.lines.some((l) => l.key === 'src/x/a.mjs'), 'a * does not cross into src/x/')
  assert.equal(out.total, flat.length)
})

test('a grep path with ? is one character of the name', async () => {
  const out = await grep(tree, { pattern: 'NEEDLE_ID', paths: ['src/?.mjs'] }, { scope: ['.'] })
  assert.deepEqual(out.lines, matchesOf(/NEEDLE_ID/, (k) => k === 'src/a.mjs'))
  assert.ok(out.lines.length > 0)
})

test('grep reads literal and glob paths together: a literal part is read whole, a glob part is filtered', async () => {
  const out = await grep(tree, { pattern: 'NEEDLE_ID', paths: ['test', 'src/*.mjs'] }, { scope: ['.'] })
  const want = matchesOf(/NEEDLE_ID/, (k) => k.startsWith('test/') || /^src\/[^/]+\.mjs$/.test(k))
  assert.ok(want.some((l) => l.key.startsWith('test/')) && want.some((l) => l.key.startsWith('src/')))
  assert.deepEqual(out.lines, want)
})

test('a grep path glob reaches into a submodule, and a files glob lists there', async () => {
  const out = await grep(tree, { pattern: 'NEEDLE_ID', paths: ['vendor/s/lib/*.mjs'] }, { scope: ['.'] })
  assert.deepEqual(out.lines, [{ key: 'vendor/s/lib/s.mjs', line: 1, text: 'export const NEEDLE_ID = 1' }])
  assert.deepEqual((await files(tree, { glob: 'vendor/s/lib/*.mjs' }, { scope: ['.'] })).keys, ['vendor/s/lib/s.mjs'])
})

test('a grep path glob is judged by its literal base against the scope', async () => {
  assert.equal((await grep(tree, { pattern: 'NEEDLE_ID', paths: ['src/*.mjs'] }, { scope: ['src'] })).ok, true)
  refusedAs(await grep(tree, { pattern: 'NEEDLE_ID', paths: ['app/[id]/*'] }, { scope: ['src'] }), 'outside_scope')
  refusedAs(await grep(tree, { pattern: 'NEEDLE_ID', paths: ['src/*.mjs'] }, { scope: ['app'] }), 'outside_scope')
})

test('a scope part that is a glob is matched in the search dialect', async () => {
  const tests = await grep(tree, { pattern: 'NEEDLE_ID' }, { scope: ['**/*.test.mjs'] })
  assert.deepEqual(tests.lines, matchesOf(/NEEDLE_ID/, (k) => k.endsWith('.test.mjs')))
  const listed = await files(tree, { glob: '**' }, { scope: ['src/**/*.mjs'] })
  assert.deepEqual(listed.keys, reached.map(([k]) => k).filter((k) => k.startsWith('src/') && k.endsWith('.mjs')).sort())
  const route = await files(tree, { glob: '**' }, { scope: ['app/[id]/**'] })
  assert.deepEqual(route.keys, ['app/[id]/page view.tsx'], '[id] is the literal name, so the decoy app/i/ a class would add is not in scope')
  const decoy = await files(tree, { glob: '**' }, { scope: ['app/i/**'] })
  assert.deepEqual(decoy.keys, ['app/i/page view.tsx'])
})

test('a scope part with a single * or a ? is a glob too', async () => {
  const flat = reached.map(([k]) => k).filter((k) => /^src\/[^/]+\.mjs$/.test(k)).sort()
  assert.ok(flat.length >= 2 && reached.some(([k]) => k === 'src/x/a.mjs'), 'the fixture has src/*.mjs files and one a directory down')
  assert.deepEqual((await files(tree, { glob: '**' }, { scope: ['src/*.mjs'] })).keys, flat)
  assert.deepEqual((await files(tree, { glob: '**' }, { scope: ['src/?.mjs'] })).keys, ['src/a.mjs'])
  assert.deepEqual((await grep(tree, { pattern: 'NEEDLE_ID' }, { scope: ['src/*.mjs'] })).lines, matchesOf(/NEEDLE_ID/, (k) => flat.includes(k)))
  assert.equal((await read(tree, { path: 'src/a.mjs' }, { scope: ['src/*.mjs'] })).ok, true)
  refusedAs(await read(tree, { path: 'src/x/a.mjs' }, { scope: ['src/*.mjs'] }), 'outside_scope')
})

test('a scope part that holds brackets and no wildcard is a directory or a file of that name', async () => {
  assert.deepEqual((await grep(tree, { pattern: 'NEEDLE_ID' }, { scope: ['app/[id]'] })).lines.map((l) => l.key), ['app/[id]/page view.tsx'])
  assert.equal((await read(tree, { path: 'app/[id]/page view.tsx' }, { scope: ['app/[id]/page view.tsx'] })).ok, true)
  refusedAs(await read(tree, { path: 'app/i/page view.tsx' }, { scope: ['app/[id]'] }), 'outside_scope')
})

test('a scope inside a submodule greps the submodule', async () => {
  assert.deepEqual((await grep(tree, { pattern: 'NEEDLE_ID' }, { scope: ['vendor/s'] })).lines, [{ key: 'vendor/s/lib/s.mjs', line: 1, text: 'export const NEEDLE_ID = 1' }])
})

test('a pattern the dialect refuses or git cannot compile is refused, never thrown', async () => {
  refusedAs(await grep(tree, { pattern: '\\bNEEDLE' }, { scope: ['.'] }), 'unsupported_syntax')
  refusedAs(await grep(tree, { pattern: 'a\0b' }, { scope: ['.'] }), 'unsupported_syntax')
  refusedAs(await grep(tree, { pattern: 'NEEDLE(' }, { scope: ['.'] }), 'does_not_compile')
})

test("grep's query_key is the query's identity", async () => {
  const a = await grep(tree, { pattern: 'NEEDLE_ID', paths: ['src', 'test'] }, { scope: ['.'] })
  const b = await grep(tree, { pattern: 'NEEDLE_ID', paths: ['test', 'src'] }, { scope: ['.'] })
  const c = await grep(tree, { pattern: 'NEEDLE_IDX', paths: ['src', 'test'] }, { scope: ['.'] })
  assert.equal(typeof a.query_key, 'string')
  assert.equal(a.query_key, b.query_key)
  assert.notEqual(a.query_key, c.query_key)
})

// ------------------------------------------------------------------ read

test('read returns the lines asked for, and where it stopped', async () => {
  const out = await read(tree, { path: 'src/a.mjs', from: 2, to: 3 })
  const all = linesOf(FILES['src/a.mjs'].text)
  assert.equal(out.ok, true)
  assert.deepEqual([out.key, out.from, out.to, out.total_lines], ['src/a.mjs', 2, 3, all.length])
  assert.deepEqual(out.lines, all.slice(1, 3).map((text, i) => ({ line: i + 2, text })))
})

test('read to 0 reads to the end, a page at most, and says where it stopped', async () => {
  const whole = await read(tree, { path: 'src/a.mjs' })
  assert.deepEqual([whole.from, whole.to, whole.total_lines, whole.lines.length], [1, 4, 4, 4])
  const big = await read(tree, { path: 'big.txt', from: 3 })
  assert.equal(big.lines.length, PAGE_LINES)
  assert.equal(big.to, 3 + PAGE_LINES - 1)
  assert.equal(big.total_lines, ROWS)
  assert.deepEqual(big.lines.at(-1), { line: big.to, text: 'row ' + big.to })
})

test('read gives CRLF text without its CR, and keys a path with brackets and spaces', async () => {
  const out = await read(tree, { path: 'app/[id]/page view.tsx' })
  assert.equal(out.key, 'app/[id]/page view.tsx')
  assert.deepEqual(out.lines.map((l) => l.text), ['line one', 'NEEDLE_ID 7', 'end'])
})

test('read refuses a line past the end, a path that is no key, and a key outside its scope', async () => {
  refusedAs(await read(tree, { path: 'src/a.mjs', from: 5 }), 'past_eof')
  refusedAs(await read(tree, { path: 'nested/x.txt' }), 'not_canonical')
  refusedAs(await read(tree, { path: 'src/a.mjs' }, { scope: ['app'] }), 'outside_scope')
})

test('read refuses the store', async () => {
  const key = '.agentics/runs/r/calls.jsonl'
  assert.equal(readFileSync(join(tree.root, key), 'utf8').length > 0, true, 'the file is there to be read')
  const spellings = [key, './' + key, join(tree.root, key)]
  if (process.platform === 'win32') spellings.push(key.split('/').join('\\'), '.AGENTICS/runs/r/calls.jsonl')
  for (const path of spellings) {
    refusedAs(await read(tree, { path }, { scope: ['.'] }), 'not_canonical')
    refusedAs(keyOf(tree, path), 'not_canonical')
  }
})

test('read refuses a worktree copy', async () => {
  for (const path of ['.claude/worktrees/loose/a.ts', '.claude/worktrees/w/src/a.mjs', './.claude/worktrees/loose/a.ts', join(tree.root, '.claude/worktrees/loose/a.ts')]) {
    refusedAs(await read(tree, { path }, { scope: ['.'] }), 'not_canonical')
    refusedAs(keyOf(tree, path), 'not_canonical')
  }
})

test('read still reads a key that only looks fenced', async () => {
  for (const [path, text] of [['.agenticsx/a.txt', 'not the store'], ['.claude/settings.json', '{}']]) {
    const out = await read(tree, { path }, { scope: ['.'] })
    assert.equal(out.ok, true, path + ' ' + JSON.stringify(out))
    assert.deepEqual([out.key, out.lines.map((l) => l.text)], [path, [text]])
    assert.deepEqual(keyOf(tree, path), { ok: true, key: path })
  }
})

// ------------------------------------------------------------------ files

test('files lists the keys a glob matches over the tree the tools reach', async () => {
  const out = await files(tree, { glob: '**/*.mjs' }, { scope: ['.'] })
  const want = reached.map(([k]) => k).filter((k) => k.endsWith('.mjs')).sort()
  assert.deepEqual(out.keys, want)
  assert.deepEqual([out.total, out.page, out.pages], [want.length, 1, Math.ceil(want.length / PAGE_LINES)])
})

test("files' **/CLAUDE.md matches the root's CLAUDE.md as well as deeper ones", async () => {
  const out = await files(tree, { glob: '**/CLAUDE.md' }, { scope: ['.'] })
  assert.deepEqual(out.keys, reached.map(([k]) => k).filter((k) => k.split('/').at(-1) === 'CLAUDE.md').sort())
  assert.ok(out.keys.includes('CLAUDE.md'))
})

test('files stays inside its scope', async () => {
  const out = await files(tree, { glob: '**' }, { scope: ['src'] })
  assert.deepEqual(out.keys, reached.map(([k]) => k).filter((k) => k.startsWith('src/')).sort())
})

test('files reads brackets literally', async () => {
  const out = await files(tree, { glob: 'app/[id]/*' }, { scope: ['.'] })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.deepEqual(out.keys, ['app/[id]/page view.tsx'], 'a class reading would add the decoy app/i/page view.tsx')
  assert.deepEqual([out.total, out.page, out.pages], [1, 1, 1])
  assert.deepEqual((await files(tree, { glob: 'app/[id]/page view.tsx' }, { scope: ['.'] })).keys, ['app/[id]/page view.tsx'], 'a glob with no wildcard is the name it spells')
  assert.deepEqual((await files(tree, { glob: 'app/[id]/**' }, { scope: ['.'] })).keys, ['app/[id]/page view.tsx'])
})

test('a glob written as brace alternation is refused, never matched as nothing', async () => {
  const listed = await files(tree, { glob: '**/{CLAUDE.md,AGENTS.md}' }, { scope: ['.'] })
  assert.equal(listed.ok, false, JSON.stringify(listed))
  assert.equal(listed.refusal, 'unsupported_syntax')
  const grepped = await grep(tree, { pattern: 'x', paths: ['src/{a,b}.mjs'] }, { scope: ['.'] })
  assert.equal(grepped.ok, false, JSON.stringify(grepped))
  assert.equal(grepped.refusal, 'unsupported_syntax')
})

test('files keeps * within a segment and reads ? as one character', async () => {
  const flat = reached.map(([k]) => k).filter((k) => /^src\/[^/]+\.mjs$/.test(k)).sort()
  assert.ok(flat.length >= 2)
  assert.deepEqual((await files(tree, { glob: 'src/*.mjs' }, { scope: ['.'] })).keys, flat)
  assert.deepEqual((await files(tree, { glob: 'src/?.mjs' }, { scope: ['.'] })).keys, ['src/a.mjs'])
  assert.deepEqual((await files(tree, { glob: 'src/*/a.mjs' }, { scope: ['.'] })).keys, ['src/x/a.mjs'])
})

test('files never lists a fenced key', async () => {
  const fencedKey = (k) => /^(\.agentics|\.claude\/worktrees)(\/|$)/.test(k)
  const reachable = reached.map(([k]) => k)
  assert.ok(!reachable.some(fencedKey), 'the fixture reaches no fenced key')
  for (const [glob, scope] of [['**', ['.']], ['**/*', ['.']], ['**/*.jsonl', ['.']], ['**/a.ts', ['.']], ['.agentics/**', ['.']], ['.claude/worktrees/**', ['.']],
    ['.claude/**', ['.']], ['**', ['.claude/worktrees']], ['**', ['.agentics']], ['**', ['.claude']]]) {
    const out = await files(tree, { glob }, { scope })
    const keys = out.ok ? out.keys : []
    assert.deepEqual(keys.filter(fencedKey), [], glob + ' in ' + scope + ' lists a fenced key')
  }
  const all = (await files(tree, { glob: '**' }, { scope: ['.'] })).keys
  for (const k of reachable) assert.ok(all.includes(k), 'the fence takes no other key with it: ' + k)
})

test('files lists a key that only looks fenced', async () => {
  const out = await files(tree, { glob: '**' }, { scope: ['.'] })
  assert.ok(out.keys.includes('.agenticsx/a.txt'), '.agenticsx is not .agentics')
  assert.ok(out.keys.includes('.claude/settings.json'), '.claude is fenced only below worktrees')
  assert.deepEqual((await files(tree, { glob: '.claude/**' }, { scope: ['.'] })).keys, ['.claude/settings.json'])
})

// ------------------------------------------------------------------ refs

test('refs counts word-bounded references by file, tests marked, total their sum', async () => {
  const out = await refs(tree, { symbol: 'NEEDLE_ID' }, { scope: ['.'] })
  const word = /(^|[^A-Za-z0-9_])NEEDLE_ID([^A-Za-z0-9_]|$)/
  const byKey = new Map()
  for (const l of matchesOf(word)) byKey.set(l.key, (byKey.get(l.key) || 0) + 1)
  assert.deepEqual(out.files, [...byKey].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, count]) => ({ key, count, test: isTestKey(key) })))
  assert.equal(out.total, [...byKey.values()].reduce((n, c) => n + c, 0))
  assert.ok(out.files.some((f) => f.test), 'the fixture has a test file among them')
})

test('refs takes the symbol as a fixed string', async () => {
  const out = await refs(tree, { symbol: 'a.b' }, { scope: ['src'] })
  assert.deepEqual(out.files.map((f) => [f.key, f.count]), [['src/a.mjs', 1]])
})

// ------------------------------------------------------------------ history

test('log -G finds the commit that added a matching line, with its full sha and the paths it touched', async () => {
  const out = await log(tree, { mode: 'G', pattern: 'NEEDLE_ID \\d' })
  assert.equal(out.ok, true, JSON.stringify(out))
  const route = out.commits.find((c) => c.subject === 'add the needle route')
  assert.ok(route, JSON.stringify(out.commits))
  assert.match(route.sha, /^[0-9a-f]{40}$/)
  assert.ok(shas.includes(route.sha))
  assert.ok(route.keys.includes('app/[id]/page view.tsx'))
  assert.equal(typeof route.date, 'string')
  assert.equal(out.total, out.commits.length)
})

test('log -S and log --grep search counts and messages', async () => {
  assert.ok((await log(tree, { mode: 'S', pattern: 'NEEDLE_IDX' })).commits.some((c) => c.subject === 'init'))
  assert.deepEqual((await log(tree, { mode: 'grep', pattern: 'vendor.*sub' })).commits.map((c) => c.subject), ['vendor the sub'])
})

test("log walks the tree's HEAD, not every branch", async () => {
  assert.deepEqual((await log(tree, { mode: 'grep', pattern: 'side commit' })).commits, [])
  assert.deepEqual((await log(tree, { mode: 'S', pattern: 'a side line' })).commits, [])
})

test('log refuses a mode it does not know and a pattern the dialect refuses', async () => {
  refusedAs(await log(tree, { mode: 'L', pattern: 'x' }), 'unsupported_syntax')
  refusedAs(await log(tree, { mode: 'G', pattern: '\\bx' }), 'unsupported_syntax')
})

test('show gives a commit, or one path in it, by its full sha, numbered from 1', async () => {
  const route = shas[1]
  const out = await show(tree, { commit: route.slice(0, 10) })
  assert.equal(out.sha, route)
  assert.deepEqual(out.lines.map((l) => l.line), out.lines.map((_, i) => i + 1))
  assert.ok(out.lines.some((l) => l.text.includes('NEEDLE_ID 7')))
  const one = await show(tree, { commit: shas[2], path: 'src/a.mjs' })
  assert.ok(one.lines.some((l) => l.text.includes('src/a.mjs')))
  assert.ok(!one.lines.some((l) => l.text.includes('big.txt')), 'only that path of the commit, which also added big.txt')
  refusedAs(await show(tree, { commit: 'no-such-commit' }), 'not_canonical')
  refusedAs(await show(tree, { commit: '--all' }), 'not_canonical')
})

// ------------------------------------------------------------------ web

const LONG = Array.from({ length: 2 * PAGE_LINES + 3 }, (_, i) => 'para ' + (i + 1)).join('\r\n') + '\r\n'
/** A local web server: /doc, /long (three pages, CRLF), /empty, and 404 for anything else. */
async function webServer(t) {
  const server = createServer((req, res) => {
    const body = { '/doc': 'Grüße, docs\n', '/long': LONG, '/empty': '' }[req.url]
    if (body === undefined) { res.writeHead(404); res.end('gone') } else { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(body) }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => server.close())
  return 'http://127.0.0.1:' + server.address().port
}

test('fetchUrl gives a page with its web key, status, lines and size', async (t) => {
  const at = await webServer(t)
  const url = at + '/doc#part'
  const out = await fetchUrl({ url }, { pages: mkdtempSync(join(tmpdir(), 'pin-')) })
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.deepEqual([out.key, out.status, out.page, out.pages, out.lines, out.bytes],
    [canonicalUrl(url), 200, 1, 1, [{ line: 1, text: 'Grüße, docs' }], Buffer.byteLength('Grüße, docs\n')])
  const missing = await fetchUrl({ url: at + '/nope' }, { pages: mkdtempSync(join(tmpdir(), 'pin-')) })
  assert.deepEqual([missing.ok, missing.status], [true, 404], 'any HTTP status is an answer')
})

test('fetchUrl pages a long page, and a page past the last is past_eof', async (t) => {
  const at = await webServer(t)
  const all = LONG.split('\r\n').slice(0, -1)
  const pages = Math.ceil(all.length / PAGE_LINES)
  const got = []
  for (let p = 1; p <= pages; p++) {
    const out = await fetchUrl({ url: at + '/long', page: p }, { pages: mkdtempSync(join(tmpdir(), 'pin-')) })
    assert.deepEqual([out.page, out.pages, out.bytes], [p, pages, Buffer.byteLength(LONG)])
    got.push(...out.lines)
  }
  assert.deepEqual(got, all.map((text, i) => ({ line: i + 1, text })), 'the pages together are the page, numbered through, without CR')
  refusedAs(await fetchUrl({ url: at + '/long', page: pages + 1 }, { pages: mkdtempSync(join(tmpdir(), 'pin-')) }), 'past_eof')
  const empty = await fetchUrl({ url: at + '/empty' }, { pages: mkdtempSync(join(tmpdir(), 'pin-')) })
  assert.deepEqual([empty.ok, empty.page, empty.lines], [true, 1, []], 'page 1 of an empty page is ok')
})

test('fetchUrl refuses what is not an http URL and names a server that never answered', async () => {
  refusedAs(await fetchUrl({ url: 'file:///etc/passwd' }, { pages: mkdtempSync(join(tmpdir(), 'pin-')) }), 'not_canonical')
  refusedAs(await fetchUrl({ url: 'not a url' }, { pages: mkdtempSync(join(tmpdir(), 'pin-')) }), 'not_canonical')
  const closed = createServer()
  await new Promise((r) => closed.listen(0, '127.0.0.1', r))
  const port = closed.address().port
  await new Promise((r) => closed.close(r))
  refusedAs(await fetchUrl({ url: 'http://127.0.0.1:' + port + '/' }, { pages: mkdtempSync(join(tmpdir(), 'pin-')) }), 'expander_error')
})

// ------------------------------------------------------------------ pure

test('a test file is one under a test, tests or __tests__ segment, or named .test. or .spec.', () => {
  for (const k of ['test/a.mjs', 'src/tests/x.js', 'a/__tests__/b.js', 'lib/x.test.mjs', 'src/x.spec.ts']) assert.equal(isTestKey(k), true, k)
  for (const k of ['lib/testing.mjs', 'contest/a.js', 'src/latest.mjs', 'docs/test.md']) assert.equal(isTestKey(k), false, k)
})

test('a page is 200 lines and every refusal class is named', () => {
  assert.equal(PAGE_LINES, 200)
  assert.deepEqual(REFUSALS, ['not_canonical', 'past_eof', 'unsupported_syntax', 'does_not_compile', 'expander_error', 'unknown_ask', 'outside_scope', 'too_large'])
})

// ------------------------------------------------------------------ what the navigator is told

test('tool descriptions state the glob dialect', async () => {
  const { GLOB_RULES } = await import('../lib/search/query.mjs')
  const { toolDefs } = await import('../lib/search/server.mjs')
  assert.equal(typeof GLOB_RULES, 'string', 'the dialect has one statement')
  assert.ok(GLOB_RULES.length > 0)
  const defs = toolDefs({ asks: [{ key: 'a' }], tools: ['grep', 'read', 'files'] })
  const tool = (name) => defs.find((d) => d.name === name)
  assert.ok(tool('files').description.includes(GLOB_RULES), 'the files description carries GLOB_RULES')
  assert.equal(typeof tool('grep').inputSchema.properties.paths.description, 'string', 'the grep paths argument is described')
  assert.ok(tool('grep').inputSchema.properties.paths.description.includes(GLOB_RULES), 'the grep paths description carries GLOB_RULES')
})
