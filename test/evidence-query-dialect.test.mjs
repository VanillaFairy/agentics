// test/evidence-query-dialect.test.mjs — the evidence pool's queries run in the shared dialect: a
// shorthand class finds what it says, an unsupported token is refused at record and leaves a stored
// item stale, and a scope path is the path it names or a glob in the one search dialect, read in-process.
//
// Design: docs/DESIGN.md#items-and-anchors.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { itemId, liveItems, recordItems, recordJudgement } from '../lib/evidence.mjs'
import { appendProject } from '../lib/ledger.mjs'
import { RETURN, gitRepo, itemOf, record, stateOf, text, write } from './harness/evidence-fixture.mjs'

const CODE = ['const RETRY_LIMIT = 3', 'const name = "x"', 'wait(250)', 'done']
const matching = (re, lines = CODE, path = 'src/a.js') => lines.filter((l) => re.test(l)).map((l) => ({ path, text: l }))
const byKey = (r) => r.path + '\0' + r.text

test('an absence query with \\d is refused when the tree holds digits', () => {
  const repo = gitRepo({ 'src/a.js': text(CODE) })
  const out = recordItems(repo, RETURN, [itemOf({ kind: 'absence', claim: 'no numeric wait', queries: [{ pattern: 'wait\\(\\d+\\)', scope: ['src'] }] })])
  assert.equal(out.ok, false, 'before the dialect, \\d matched nothing and this absence was recorded as proven')
  assert.deepEqual(out.refused.map((r) => r.index), [0])
})

test('an enumeration query with \\w and \\s records what the same JavaScript regex matches', () => {
  const repo = gitRepo({ 'src/a.js': text(CODE) })
  const id = record(repo, { kind: 'enumeration', claim: 'the constants', queries: [{ pattern: 'const\\s+\\w+_\\w+', scope: ['src'] }] })
  const got = liveItems(repo).get(id).queries[0].result
  assert.deepEqual(got.map(byKey).sort(), matching(/const\s+\w+_\w+/).map(byKey).sort())
  assert.ok(got.length > 0)
})

test('every shorthand class, outside and inside brackets, finds what the same JavaScript regex finds', () => {
  const lines = ['plain', '12345', 'snake_case', 'two words', '   ', '!!!', 'tab\there', 'x9', 'a-b', '_', '7 up', 'MiXeD']
  const repo = gitRepo({ 'src/a.js': text(lines) })
  const patterns = ['\\d', '\\D', '\\s', '\\S', '\\w', '\\W', '[\\d_]', '[^\\w ]', '[\\s,!]', '[^\\d\\s]', '^\\w+$', '\\d\\s\\w', '[a\\d]\\W']
  for (const pattern of patterns) {
    const id = record(repo, { kind: 'enumeration', claim: 'lines holding ' + pattern, queries: [{ pattern, scope: ['src'] }] })
    const want = matching(new RegExp(pattern), lines)
    assert.ok(want.length > 0, pattern + ' matches some line, or this test shows nothing')
    assert.deepEqual(liveItems(repo).get(id).queries[0].result.map(byKey).sort(), want.map(byKey).sort(), pattern)
  }
})

test('a query with an unsupported token is refused at record, naming the dialect', () => {
  const repo = gitRepo({ 'src/a.js': text(CODE) })
  for (const pattern of ['\\bwait\\b', '(?:wait)', 'wa.*?t']) {
    const out = recordItems(repo, RETURN, [itemOf({ kind: 'enumeration', claim: 'unsupported ' + pattern, queries: [{ pattern, scope: ['src'] }] })])
    assert.equal(out.ok, false, pattern)
    assert.ok(out.refused[0].problems.some((p) => p.includes('unsupported_syntax')), JSON.stringify(out.refused))
  }
})

test('a refused query refuses its whole batch and writes nothing', () => {
  const repo = gitRepo({ 'src/a.js': text(CODE) })
  const good = itemOf({ kind: 'enumeration', claim: 'the waits', queries: [{ pattern: 'wait', scope: ['src'] }] })
  const bad = itemOf({ kind: 'enumeration', claim: 'a word boundary', queries: [{ pattern: '\\bwait\\b', scope: ['src'] }] })
  const out = recordItems(repo, RETURN, [good, bad])
  assert.equal(out.ok, false)
  assert.deepEqual(out.refused.map((r) => r.index), [1], 'only the item that holds the token is named')
  assert.equal(liveItems(repo).size, 0, 'the good item was not written either')
})

test('a NUL byte in a query pattern or a scope path is refused at record', () => {
  const repo = gitRepo({ 'src/a.js': text(CODE) })
  for (const q of [{ pattern: 'wa\u0000it', scope: ['src'] }, { pattern: 'wait', scope: ['sr\u0000c'] }]) {
    const out = recordItems(repo, RETURN, [itemOf({ kind: 'enumeration', claim: 'nul ' + JSON.stringify(q), queries: [q] })])
    assert.equal(out.ok, false, JSON.stringify(q))
    assert.deepEqual(out.refused.map((r) => r.index), [0])
  }
})

test('a stored item whose query the dialect refuses is stale, never thrown', () => {
  const repo = gitRepo({ 'src/a.js': text(CODE) })
  const control = itemOf({ kind: 'absence', claim: 'a stored plain query', queries: [{ pattern: 'never', scope: ['src'], result: [] }], from_return: RETURN })
  const item = itemOf({ kind: 'absence', claim: 'a stored word-boundary query', queries: [{ pattern: '\\bnever\\b', scope: ['src'], result: [] }], from_return: RETURN })
  const stored = [control, item].map((i) => ({ kind: 'item', item: { ...i, id: itemId(i) } }))
  assert.equal(appendProject(repo, 'items', stored).ok, true)
  assert.equal(stateOf(repo, itemId(control)).state, 'standing', 'the same item with a supported pattern stands, so only the pattern makes the difference')
  assert.equal(stateOf(repo, itemId(item)).state, 'stale')
})

test('re-judging a stored item whose query the dialect refuses leaves it stale', () => {
  const repo = gitRepo({ 'src/a.js': text(CODE) })
  const item = itemOf({ kind: 'absence', claim: 'a stored word-boundary query', queries: [{ pattern: '\\bnever\\b', scope: ['src'], result: [] }], from_return: RETURN })
  assert.equal(appendProject(repo, 'items', [{ kind: 'item', item: { ...item, id: itemId(item) } }]).ok, true)
  const out = recordJudgement(repo, itemId(item), 'holds')
  assert.equal(out.ok, true, JSON.stringify(out))
  assert.equal(out.state, 'stale', 'a query that cannot be re-run cannot be re-anchored')
  assert.equal(stateOf(repo, itemId(item)).state, 'stale')
})

test('a scope path with brackets names that path, not a glob', () => {
  const repo = gitRepo({ 'app/[id]/page.tsx': text(['the needle']), 'app/i/page.tsx': text(['the needle']), 'app/d/page.tsx': text(['the needle']) })
  const id = record(repo, { kind: 'enumeration', claim: 'needles in the route', ground: ['app'], queries: [{ pattern: 'needle', scope: ['app/[id]/page.tsx'] }] })
  assert.deepEqual(liveItems(repo).get(id).queries[0].result.map((r) => r.path), ['app/[id]/page.tsx'],
    'a plain pathspec reads [id] as a character class and also matches app/i/page.tsx and app/d/page.tsx')
})

/** The paths a recorded enumeration of `needle` over `scope` found, sorted. */
function foundIn(repo, scope, ground = ['.']) {
  const id = record(repo, { kind: 'enumeration', claim: 'needles in ' + scope.join(' '), ground, queries: [{ pattern: 'needle', scope }] })
  return [...new Set(liveItems(repo).get(id).queries[0].result.map((r) => r.path))].sort()
}

test('a lone * in a scope path matches within one segment', () => {
  const repo = gitRepo({ 'lib/a.mjs': text(['the needle']), 'lib/b.mjs': text(['no match here']), 'lib/deep/c.mjs': text(['the needle']), 'lib/d.txt': text(['the needle']) })
  assert.deepEqual(foundIn(repo, ['lib/*.mjs'], ['lib']), ['lib/a.mjs'], 'not lib/deep/c.mjs, which a * does not reach, and not lib/d.txt')
})

test('a ? in a scope path is one character of the name', () => {
  const repo = gitRepo({ 'src/a.js': text(['needle']), 'src/ab.js': text(['needle']), 'src/x/c.js': text(['needle']) })
  assert.deepEqual(foundIn(repo, ['src/?.js'], ['src']), ['src/a.js'])
})

test('a scope with ** reaches every depth under it', () => {
  const repo = gitRepo({ 'src/a.js': text(['needle']), 'src/deep/er/b.js': text(['needle']), 'lib/c.js': text(['needle']) })
  const id = record(repo, { kind: 'enumeration', claim: 'needles in src', queries: [{ pattern: 'needle', scope: ['src/**/*.js'] }] })
  assert.deepEqual(liveItems(repo).get(id).queries[0].result.map((r) => r.path).sort(), ['src/a.js', 'src/deep/er/b.js'])
})

test('a stored glob scope is filtered in-process', () => {
  const repo = gitRepo({
    'src/a/b.ts': text(['x needle']), 'src/a/b.js': text(['x needle']), 'src/top.ts': text(['x needle']), 'lib/c.ts': text(['x needle']),
    'app/[id]/page.tsx': text(['needle']), 'app/[id]/page.ts': text(['needle']), 'app/[id]/deep/x.tsx': text(['needle']), 'app/i/page.tsx': text(['needle']),
  })
  assert.deepEqual(foundIn(repo, ['src/**/*.ts'], ['src']), ['src/a/b.ts', 'src/top.ts'], 'no src/a/b.js, no lib/c.ts')
  assert.deepEqual(foundIn(repo, ['app/[id]/*.tsx'], ['app']), ['app/[id]/page.tsx'], '[id] is the literal name, * stays in its segment, .ts is not .tsx')
})

test('a stored literal scope is a directory', () => {
  const repo = gitRepo({
    'src/a.js': text(['needle']), 'src/deep/b.js': text(['needle']), 'src/deep/er/c.js': text(['needle']), 'srcx/d.js': text(['needle']),
    'app/[id]/page.tsx': text(['needle']), 'app/i/page.tsx': text(['needle']),
  })
  assert.deepEqual(foundIn(repo, ['src'], ['src']), ['src/a.js', 'src/deep/b.js', 'src/deep/er/c.js'], 'every file under it, and not the srcx beside it')
  assert.deepEqual(foundIn(repo, ['app/[id]'], ['app']), ['app/[id]/page.tsx'], 'a directory whose name holds brackets')
})

test('a literal part of a scope is read whole beside a glob part that is filtered', () => {
  const repo = gitRepo({ 'src/a.js': text(['needle']), 'src/deep/b.js': text(['needle']), 'lib/a.mjs': text(['needle']), 'lib/deep/c.mjs': text(['needle']), 'lib/d.txt': text(['needle']) })
  assert.deepEqual(foundIn(repo, ['src', 'lib/*.mjs']), ['lib/a.mjs', 'src/a.js', 'src/deep/b.js'])
})

test('a glob scope never reads .agentics', () => {
  const repo = gitRepo({ 'src/a.md': text(['the needle']), '.agentics/note.md': text(['the needle']) })
  assert.deepEqual(foundIn(repo, ['**/*.md']), ['src/a.md'])
})

test('a stored glob scope is re-run in the same dialect', () => {
  const repo = gitRepo({ 'app/[id]/page.tsx': text(['the needle']), 'app/[id]/other.ts': text(['no match']) })
  const id = record(repo, { kind: 'enumeration', claim: 'needles in the route', ground: ['app'], queries: [{ pattern: 'needle', scope: ['app/[id]/*.tsx'] }] })
  assert.deepEqual(liveItems(repo).get(id).queries[0].result.map((r) => r.path), ['app/[id]/page.tsx'], 'the glob read at record')
  assert.equal(stateOf(repo, id).state, 'standing')
  write(repo, 'app/i/page.tsx', text(['the needle']))
  write(repo, 'app/[id]/deep/x.tsx', text(['the needle']))
  assert.equal(stateOf(repo, id).state, 'standing', 'a file outside the glob, beside it or a directory down, changes nothing the query reads')
  write(repo, 'app/[id]/second.tsx', text(['the needle']))
  assert.equal(stateOf(repo, id).state, 'suspect', 'a file the glob matches does')
})

test('a scope of a plain directory and one of a file are each that path', () => {
  const repo = gitRepo({ 'src/a.js': text(['needle']), 'src/deep/b.js': text(['needle']), 'lib/c.js': text(['needle']), 'my dir/d.js': text(['needle']) })
  const dir = record(repo, { kind: 'enumeration', claim: 'needles in src', queries: [{ pattern: 'needle', scope: ['src'] }] })
  assert.deepEqual(liveItems(repo).get(dir).queries[0].result.map((r) => r.path).sort(), ['src/a.js', 'src/deep/b.js'])
  const spaced = record(repo, { kind: 'enumeration', claim: 'needles in my dir', queries: [{ pattern: 'needle', scope: ['my dir/d.js'] }] })
  assert.deepEqual(liveItems(repo).get(spaced).queries[0].result.map((r) => r.path), ['my dir/d.js'])
})

test('a query over the whole tree never reads .agentics', () => {
  const repo = gitRepo({ 'src/a.js': text(['the needle']), '.agentics/note.md': text(['the needle']) })
  const id = record(repo, { kind: 'enumeration', claim: 'needles anywhere', ground: ['.'], queries: [{ pattern: 'needle', scope: [] }] })
  assert.deepEqual(liveItems(repo).get(id).queries[0].result.map((r) => r.path), ['src/a.js'])
})

test('a match in a binary file stays in the pool\'s result', () => {
  const lines = ['head\u0000tail', 'the needle here', 'last']
  const repo = gitRepo({ 'data/blob.bin': text(lines) })
  const id = record(repo, { kind: 'enumeration', claim: 'needles in data', ground: ['data'], queries: [{ pattern: 'needle', scope: ['data'] }] })
  assert.deepEqual(liveItems(repo).get(id).queries[0].result.map(byKey).sort(), matching(/needle/, lines, 'data/blob.bin').map(byKey).sort())
})
