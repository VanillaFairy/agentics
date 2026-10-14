// test/fast/search-query.test.mjs — pins the one query dialect: what queryOf transpiles, what it
// refuses and why, the pathspecs and identity it gives a query, the argument lists grepArgv builds,
// and that the survey judge's brief names the dialect it is held to.
//
// Design: docs/DESIGN.md#evidence.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { judgeBrief } from '../../lib/briefs/survey.mjs'
import { grepArgv, queryOf } from '../../lib/search/query.mjs'

const OUTSIDE = { '\\d': '[[:digit:]]', '\\D': '[^[:digit:]]', '\\s': '[[:space:]]', '\\S': '[^[:space:]]', '\\w': '[[:alnum:]_]', '\\W': '[^[:alnum:]_]' }
const INSIDE = { '\\d': '[:digit:]', '\\s': '[:space:]', '\\w': '[:alnum:]_' }
const EXCLUDE = ':(exclude).agentics'

function refusedFor(pattern, extra = {}) {
  const q = queryOf({ pattern, ...extra })
  assert.equal(q.ok, false, JSON.stringify(pattern) + ' is refused')
  assert.equal(q.refusal, 'unsupported_syntax', JSON.stringify(pattern))
  assert.equal(typeof q.detail, 'string')
  assert.ok(q.detail.length > 0, 'a refusal says why')
}

test('each shorthand class outside brackets becomes its POSIX bracket expression', () => {
  for (const [token, posix] of Object.entries(OUTSIDE)) {
    const q = queryOf({ pattern: 'id ' + token + '+ end' })
    assert.equal(q.ok, true, token)
    assert.equal(q.pattern, 'id ' + posix + '+ end', token)
  }
})

test('every occurrence is transpiled, in order, with the text between kept as it is', () => {
  assert.equal(queryOf({ pattern: '\\d\\w' }).pattern, '[[:digit:]][[:alnum:]_]')
  assert.equal(queryOf({ pattern: 'a\\sb\\sc\\Sd' }).pattern, 'a[[:space:]]b[[:space:]]c[^[:space:]]d')
  assert.equal(queryOf({ pattern: '^(\\w+)=\\d{2,3}$' }).pattern, '^([[:alnum:]_]+)=[[:digit:]]{2,3}$')
})

test('a pattern with nothing to transpile comes back as it was given', () => {
  for (const p of ['plain', 'a.*b', '^(foo|bar)+$', '[[:digit:]]+', '[a-z_]{2,}', 'x\\.y', 'a|b']) {
    const q = queryOf({ pattern: p })
    assert.equal(q.ok, true, p)
    assert.equal(q.pattern, p, p)
  }
})

test('inside a bracket expression \\d \\s \\w become the classes they add', () => {
  for (const [token, cls] of Object.entries(INSIDE)) {
    assert.equal(queryOf({ pattern: '[' + token + '-]' }).pattern, '[' + cls + '-]', token)
    assert.equal(queryOf({ pattern: '[^' + token + ']' }).pattern, '[^' + cls + ']', token + ' in a negated bracket')
  }
  assert.equal(queryOf({ pattern: '[[:alpha:]\\d]' }).pattern, '[[:alpha:][:digit:]]', 'a POSIX class beside one')
  assert.equal(queryOf({ pattern: '[\\d\\s_]' }).pattern, '[[:digit:][:space:]_]', 'several in one bracket')
})

test('a bracket expression closes where POSIX closes it, so a class after it is outside again', () => {
  assert.equal(queryOf({ pattern: '[ab]\\d' }).pattern, '[ab][[:digit:]]')
  assert.equal(queryOf({ pattern: '[]a]\\d' }).pattern, '[]a][[:digit:]]', 'a ] first in the bracket is a member')
  assert.equal(queryOf({ pattern: '[^]a]\\d' }).pattern, '[^]a][[:digit:]]', 'a ] first after the ^ is a member')
  assert.equal(queryOf({ pattern: '[a]\\D' }).pattern, '[a][^[:digit:]]', 'a \\D after a closed bracket is outside, so transpiled')
  assert.equal(queryOf({ pattern: '[a]\\d[b]\\w' }).pattern, '[a][[:digit:]][b][[:alnum:]_]', 'twice in one pattern')
})

test('\\D \\S \\W inside brackets are refused', () => {
  for (const token of ['\\D', '\\S', '\\W']) {
    refusedFor('[a' + token + ']')
    refusedFor('[^' + token + ']')
    refusedFor('[\\d' + token + ']')
  }
})

test('\\b and every other backslash-letter escape are refused', () => {
  const kept = new Set(['d', 'D', 's', 'S', 'w', 'W'])
  for (const letter of 'abcefghijklmnopqrtuvxyzABCEFGHIJKLMNOPQRTUVXYZ') {
    if (!kept.has(letter)) refusedFor('x\\' + letter + 'y')
  }
})

test('a refused escape is refused wherever it stands in the pattern', () => {
  for (const p of ['\\bword', 'word\\b', '(a|\\bb)', 'a\\d\\b']) refusedFor(p)
})

test('an escaped backslash or punctuation is kept as it is', () => {
  assert.equal(queryOf({ pattern: 'a\\\\d' }).pattern, 'a\\\\d', 'a literal backslash before d is not \\d')
  for (const p of ['a\\.b', '\\(x\\)', 'a\\+', '\\[x\\]', '\\{2\\}']) assert.equal(queryOf({ pattern: p }).pattern, p, p)
})

test('an escaped backslash is a pair, so what follows it is read on its own', () => {
  assert.equal(queryOf({ pattern: 'a\\\\b' }).ok, true, 'a literal backslash then b is not \\b')
  assert.equal(queryOf({ pattern: 'a\\\\b' }).pattern, 'a\\\\b')
  assert.equal(queryOf({ pattern: '\\\\\\d' }).pattern, '\\\\[[:digit:]]', 'a literal backslash, then \\d')
  refusedFor('\\\\\\b')
})

test("'(?' is refused: no non-capturing groups, lookaround or inline flags", () => {
  for (const p of ['(?:ab)', 'a(?=b)', 'a(?!b)', '(?<=a)b', '(?i)x']) refusedFor(p)
})

test('a lazy quantifier is refused, a greedy one is not', () => {
  for (const p of ['a*?', 'a+?', 'a??', 'a{2,3}?', '(ab)*?', 'x(ab)+?y']) refusedFor(p)
  for (const p of ['a*', 'a+', 'a?', 'a{2,3}', '(ab)?c', 'a?b?', 'a*b+c?']) assert.equal(queryOf({ pattern: p }).ok, true, p)
})

test('a NUL byte is refused in the pattern and in a path', () => {
  refusedFor('a\u0000b')
  refusedFor('a\u0000b', { fixed: true })
  refusedFor('needle', { paths: ['sr\u0000c'] })
  refusedFor('needle', { fixed: true, paths: ['src', 'sr\u0000c'] })
})

test('a fixed pattern is never transpiled and never refused for regex syntax', () => {
  for (const p of ['\\d+', '\\b(?:x)*?', 'a[\\W]']) {
    const q = queryOf({ pattern: p, fixed: true })
    assert.equal(q.ok, true, p)
    assert.equal(q.pattern, p, p)
  }
})

test('flags: -E for a regex, -F for a fixed string, -i when ignoring case', () => {
  assert.deepEqual(queryOf({ pattern: 'x' }).flags, ['-E'])
  assert.deepEqual(queryOf({ pattern: 'x', fixed: true }).flags, ['-F'])
  assert.deepEqual(queryOf({ pattern: 'x', ignore_case: true }).flags, ['-E', '-i'])
  assert.deepEqual(queryOf({ pattern: 'x', fixed: true, ignore_case: true }).flags, ['-F', '-i'])
})

test('pathspecs: the whole tree when none, literal paths, ** globs, and never .agentics', () => {
  assert.deepEqual(queryOf({ pattern: 'x' }).pathspecs, ['.', EXCLUDE])
  assert.deepEqual(queryOf({ pattern: 'x', paths: ['src'] }).pathspecs, [':(literal)src', EXCLUDE])
  assert.deepEqual(queryOf({ pattern: 'x', paths: ['src/**/*.ts'] }).pathspecs, [':(glob)src/**/*.ts', EXCLUDE])
  assert.deepEqual(queryOf({ pattern: 'x', paths: ['lib/*.mjs'] }).pathspecs, [':(literal)lib/*.mjs', EXCLUDE],
    'only ** makes a glob; a lone * is a literal character')
  assert.deepEqual(queryOf({ pattern: 'x', paths: ['app/[id]/page.tsx'] }).pathspecs, [':(literal)app/[id]/page.tsx', EXCLUDE])
  assert.deepEqual(queryOf({ pattern: 'x', paths: ['my dir/a b.ts'] }).pathspecs, [':(literal)my dir/a b.ts', EXCLUDE])
})

test('pathspecs: every path is converted by its own form, and the exclusion comes last', () => {
  const paths = ['src', 'app/[id]/page.tsx', 'lib/*.mjs', 'src/**/*.ts', 'my dir/a b.ts']
  const specs = queryOf({ pattern: 'x', paths }).pathspecs
  assert.equal(specs.length, paths.length + 1)
  assert.equal(specs.at(-1), EXCLUDE)
  const want = paths.map((p) => (p.includes('**') ? ':(glob)' : ':(literal)') + p)
  assert.deepEqual([...specs.slice(0, -1)].sort(), want.sort())
})

test('queryOf leaves the caller\'s paths as they were', () => {
  const paths = ['b', 'a']
  queryOf({ pattern: 'x', paths })
  assert.deepEqual(paths, ['b', 'a'])
})

test("a query's key is its identity: the pattern as given, its flags and its paths in any order", () => {
  const a = queryOf({ pattern: '\\d+', paths: ['b', 'a'] })
  const b = queryOf({ pattern: '\\d+', paths: ['a', 'b'] })
  assert.equal(typeof a.key, 'string')
  assert.equal(a.key, b.key, 'path order is not identity')
  assert.deepEqual(JSON.parse(a.key), { pattern: '\\d+', fixed: false, ignore_case: false, paths: ['a', 'b'] }, 'the pattern as given, before transpiling')
  for (const other of [{ pattern: '\\d*', paths: ['a', 'b'] }, { pattern: '\\d+', fixed: true, paths: ['a', 'b'] },
    { pattern: '\\d+', ignore_case: true, paths: ['a', 'b'] }, { pattern: '\\d+', paths: ['a'] }]) {
    assert.notEqual(queryOf(other).key, a.key, JSON.stringify(other))
  }
})

test("a query's key names the pattern as given, so a shorthand and its POSIX form are two queries", () => {
  const given = queryOf({ pattern: '\\d' })
  const posix = queryOf({ pattern: '[[:digit:]]' })
  assert.equal(given.pattern, posix.pattern)
  assert.notEqual(given.key, posix.key)
})

test("a query's key holds no paths when it has none, and says what was asked when it has", () => {
  assert.deepEqual(JSON.parse(queryOf({ pattern: 'x' }).key), { pattern: 'x', fixed: false, ignore_case: false, paths: [] })
  assert.deepEqual(JSON.parse(queryOf({ pattern: 'x', fixed: true, ignore_case: true }).key),
    { pattern: 'x', fixed: true, ignore_case: true, paths: [] })
})

test('grepArgv builds the files, lines and count argument lists', () => {
  const q = queryOf({ pattern: '\\w+', ignore_case: true, paths: ['src'] })
  const tail = [...q.flags, '-e', q.pattern, '--', ...q.pathspecs]
  assert.deepEqual(grepArgv(q, 'files'), ['grep', '-l', '-z', '-I', '--untracked', ...tail])
  assert.deepEqual(grepArgv(q, 'lines'), ['grep', '-n', '-z', '-I', '--untracked', ...tail])
  assert.deepEqual(grepArgv(q, 'count'), ['grep', '-c', '-z', '-I', '--untracked', ...tail])
})

test('grepArgv carries the query it is given: its flags, its transpiled pattern and its pathspecs', () => {
  for (const query of [{ pattern: 'a\\d' }, { pattern: 'a.b', fixed: true, ignore_case: true, paths: ['x', 'y/**'] }, { pattern: 'k', paths: ['z'] }]) {
    const q = queryOf(query)
    const tail = [...q.flags, '-e', q.pattern, '--', ...q.pathspecs]
    for (const [mode, count] of [['files', '-l'], ['lines', '-n'], ['count', '-c']]) {
      assert.deepEqual(grepArgv(q, mode), ['grep', count, '-z', '-I', '--untracked', ...tail], mode + ' ' + JSON.stringify(query))
    }
  }
})

test('grepArgv with text keeps binary files: --text where it otherwise gives -I', () => {
  const q = queryOf({ pattern: 'x', paths: ['src'] })
  for (const mode of ['files', 'lines', 'count']) {
    const argv = grepArgv(q, mode, { text: true })
    assert.deepEqual(argv, grepArgv(q, mode).map((a) => (a === '-I' ? '--text' : a)), mode)
    assert.ok(!argv.includes('-I'), mode)
  }
  assert.deepEqual(grepArgv(q, 'lines', { text: false }), grepArgv(q, 'lines'))
})

test('grepArgv hands out a list of its own: changing it changes nothing the query holds', () => {
  const q = queryOf({ pattern: 'x', paths: ['src'] })
  const before = JSON.stringify(q)
  const first = grepArgv(q, 'lines')
  first.push('--oops')
  first.length = 0
  assert.equal(JSON.stringify(q), before)
  assert.deepEqual(grepArgv(q, 'lines'), ['grep', '-n', '-z', '-I', '--untracked', ...q.flags, '-e', q.pattern, '--', ...q.pathspecs])
})

test('grepArgv passes a pattern that starts with a dash as the value of -e', () => {
  const q = queryOf({ pattern: '-x' })
  const argv = grepArgv(q, 'lines')
  assert.equal(argv[argv.indexOf('-e') + 1], '-x')
})

test("the survey judge's brief names the tokens the dialect transpiles and refuses", () => {
  const topic = { key: 't', subtree: 'src', find: 'every caller of load', search: { status: 'returned', end: 'done' } }
  const brief = judgeBrief({ question: 'q', topics: [topic], excerpts: '' })
  for (const token of [...Object.keys(OUTSIDE), '\\b', '(?']) assert.ok(brief.includes(token), 'the brief names ' + token)
})

test("the survey judge's brief reads a topic's search as its status and end", () => {
  const brief = (search) => judgeBrief({ question: 'q', topics: [{ key: 't', subtree: 'src', find: 'f', search }], excerpts: '' })
  assert.ok(brief({ status: 'returned', end: 'done' }).includes('Its search: its search ended done.\n'), 'a done search is told as done')
  assert.ok(brief({ status: 'returned', end: 'stopped', why: 'WHY-x' }).includes('its search ended stopped (WHY-x)'), 'a short search names its end and why')
  assert.ok(brief({ status: 'failed', cause: 'CAUSE-x' }).includes('its search failed (CAUSE-x)'), 'a failed search names its cause')
})
