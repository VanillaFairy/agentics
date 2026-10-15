// test/fast/search-query.test.mjs — pins the one query dialect: what queryOf transpiles, what it
// refuses and why, the pathspecs and identity it gives a query, the argument lists grepArgv builds,
// that the survey judge's brief names the dialect it is held to, and the one identity every path
// a search tool takes goes through: pathKey, fenced and globOf.
//
// Design: docs/DESIGN.md#searches and docs/DESIGN.md#items-and-anchors.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { judgeBrief } from '../../lib/briefs/survey.mjs'
import { GLOB_RULES, fenced, globOf, grepArgv, pathKey, queryOf } from '../../lib/search/query.mjs'

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

test('pathspecs: the whole tree when none, a plain path stays literal, and never .agentics', () => {
  assert.deepEqual(queryOf({ pattern: 'x' }).pathspecs, ['.', EXCLUDE])
  assert.deepEqual(queryOf({ pattern: 'x', paths: ['src'] }).pathspecs, [':(literal)src', EXCLUDE])
  assert.deepEqual(queryOf({ pattern: 'x', paths: ['src/a.ts'] }).pathspecs, [':(literal)src/a.ts', EXCLUDE])
  assert.deepEqual(queryOf({ pattern: 'x', paths: ['app/[id]/page.tsx'] }).pathspecs, [':(literal)app/[id]/page.tsx', EXCLUDE],
    'brackets are literal characters, not a wildcard')
  assert.deepEqual(queryOf({ pattern: 'x', paths: ['my dir/a b.ts'] }).pathspecs, [':(literal)my dir/a b.ts', EXCLUDE])
})

test('a glob path enumerates from its literal base', () => {
  const q = queryOf({ pattern: 'x', paths: ['app/[id]/*.tsx'] })
  assert.equal(q.ok, true)
  assert.ok(q.pathspecs.includes(':(literal)app/[id]'), JSON.stringify(q.pathspecs))
  assert.ok(q.pathspecs.includes(EXCLUDE), 'the store stays excluded')
  assert.ok(!q.pathspecs.some((s) => s.startsWith(':(glob)')), 'git is never asked to read a glob: ' + JSON.stringify(q.pathspecs))
  assert.ok(!q.pathspecs.some((s) => /[*?]/.test(s)), 'no wildcard reaches git: ' + JSON.stringify(q.pathspecs))
})

test('a glob path is enumerated through its own literal base, whichever wildcard it holds', () => {
  for (const [glob, base] of [['src/**/*.ts', 'src'], ['lib/*.mjs', 'lib'], ['src/a?c/x.ts', 'src'], ['a/b/**', 'a/b'], ['a/b/*/c.ts', 'a/b']]) {
    const specs = queryOf({ pattern: 'x', paths: [glob] }).pathspecs
    assert.ok(specs.includes(':(literal)' + base), glob + ' is enumerated from ' + base + ': ' + JSON.stringify(specs))
    assert.ok(!specs.some((s) => s.startsWith(':(glob)') || /[*?]/.test(s)), glob + ': ' + JSON.stringify(specs))
  }
})

test('a glob with no literal base is enumerated from the whole tree', () => {
  for (const glob of ['**/*.ts', '**', '*.md']) {
    const specs = queryOf({ pattern: 'x', paths: [glob] }).pathspecs
    assert.ok(specs.some((s) => s === '.' || s === ':(literal).'), glob + ' reads the whole tree: ' + JSON.stringify(specs))
    assert.ok(!specs.some((s) => s.startsWith(':(glob)') || /[*?]/.test(s)), glob + ': ' + JSON.stringify(specs))
    assert.ok(specs.includes(EXCLUDE), glob)
  }
})

test('pathspecs: every path is converted by its own form, and the exclusion comes last', () => {
  const paths = ['src', 'app/[id]/page.tsx', 'lib/*.mjs', 'src/**/*.ts', 'my dir/a b.ts']
  const specs = queryOf({ pattern: 'x', paths }).pathspecs
  assert.equal(specs.at(-1), EXCLUDE)
  for (const want of [':(literal)src', ':(literal)app/[id]/page.tsx', ':(literal)lib', ':(literal)my dir/a b.ts']) {
    assert.ok(specs.includes(want), want + ' in ' + JSON.stringify(specs))
  }
  assert.ok(!specs.some((s) => s.startsWith(':(glob)') || /[*?]/.test(s)), JSON.stringify(specs))
})

test('filters: one per glob part, null when no part is a glob', () => {
  assert.equal(queryOf({ pattern: 'x' }).filters, null)
  assert.equal(queryOf({ pattern: 'x', paths: ['src', 'app/[id]/page.tsx', 'my dir/a b.ts'] }).filters, null, 'brackets and spaces are not wildcards')
  const globs = ['lib/*.mjs', 'app/[id]/*', 'src/**/index.ts']
  const q = queryOf({ pattern: 'x', paths: ['src/a.ts', ...globs] })
  assert.ok(Array.isArray(q.filters), 'a glob part yields a filter list')
  assert.equal(q.filters.length, globs.length, 'only the glob parts have a filter, the literal one is read by its pathspec')
  assert.ok(q.filters.every((f) => f instanceof RegExp))
  const keys = ['lib/a.mjs', 'lib/d/a.mjs', 'app/[id]/page.tsx', 'app/i/page.tsx', 'src/index.ts', 'src/a/index.ts', 'src/a.ts', 'src/b/c.ts']
  const behaviour = (res) => res.map((re) => keys.filter((k) => re.test(k)).join('|')).sort()
  assert.deepEqual(behaviour(q.filters), behaviour(globs.map((g) => globOf(g).re)), 'each filter is the glob part\'s own matcher')
  assert.ok(!q.filters.some((f) => f.test('src/a.ts')), 'a literal part adds no filter')
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

// ------------------------------------------------------------------ identity: pathKey, fenced, globOf

const matches = (glob, key) => globOf(glob).re.test(key)
const GLOBS = ['src/*.ts', 'src/**', 'src/**/index.ts', '**/*.ts', '**', 'app/[id]/*', 'a?c', '*.md', 'a/*/b', 'lib/{a,b}/*.mjs', 'x/y/**/z/*.ts', 'src/a?c/x']
const KEYS = ['src/a.ts', 'src/x/a.ts', 'src/index.ts', 'src/a/b/index.ts', 'a.ts', 'README.md', 'abc', 'a/c', 'a/q/b', 'a/b/b', 'app/[id]/page.tsx',
  'app/i/page.tsx', 'lib/{a,b}/x.mjs', 'lib/a/x.mjs', 'x/y/z/q.ts', 'x/y/m/n/z/q.ts', 'x/y/z/q/r.ts', 'my dir/ü.ts', 'srcx/a.ts', 'src/a?c/x']

test('pathKey turns backslashes into slashes', () => {
  assert.equal(pathKey('a\\b\\c.ts'), 'a/b/c.ts')
  assert.equal(pathKey('.\\src\\x.ts'), 'src/x.ts', 'a backslashed leading ./ is dropped too')
  assert.equal(pathKey('a b\\ü.ts'), 'a b/ü.ts', 'spaces and non-ASCII are kept')
})

test('pathKey drops leading ./ segments', () => {
  assert.equal(pathKey('./././src/x.ts'), 'src/x.ts')
  assert.equal(pathKey('./src/x.ts'), 'src/x.ts')
  assert.equal(pathKey('src/x.ts'), 'src/x.ts', 'a key is its own key')
  assert.equal(pathKey('.hidden/x'), '.hidden/x', 'a dot-name is a name, not a ./ segment')
  assert.equal(pathKey('./.agentics/x'), '.agentics/x')
  assert.ok(pathKey('../x').includes('..'), 'a path that leaves the tree is not turned into one inside it')
})

test('pathKey drops trailing slashes', () => {
  assert.equal(pathKey('src/dir///'), 'src/dir')
  assert.equal(pathKey('src/'), 'src')
  assert.equal(pathKey('src\\dir\\'), 'src/dir')
})

test('pathKey of nothing is the root', () => {
  for (const p of ['', './', '.', '.\\', '././']) assert.equal(pathKey(p), '.', JSON.stringify(p))
})

test('pathKey is idempotent and always gives a non-empty slash-only key without a trailing slash', () => {
  for (const p of ['a\\b\\c.ts', './././src/x.ts', 'src/dir///', '', './', '.', '.\\', 'a/b', '.hidden/x', '../x', 'a b/ü.ts', '.\\src\\', '././', 'src\\dir\\\\', '.agentics/x']) {
    const k = pathKey(p)
    assert.equal(pathKey(k), k, JSON.stringify(p) + ' is a key once keyed')
    assert.ok(k.length > 0 && !k.includes('\\'), JSON.stringify(p) + ' -> ' + JSON.stringify(k))
    assert.ok(k === '.' || !k.endsWith('/'), JSON.stringify(p) + ' -> ' + JSON.stringify(k))
  }
})

test('fenced covers the store and worktrees', () => {
  for (const k of ['.agentics', '.agentics/x/y.json', '.claude/worktrees', '.claude/worktrees/a/b.ts', '.agentics/runs/r/calls.jsonl']) {
    assert.equal(fenced(k), true, k)
  }
})

test('fenced is by whole segments', () => {
  for (const k of ['.agenticsx/a', 'src/.agentics.md', '.claude/settings.json', 'docs/.claude/worktrees.md', '.agentics.md', '.agentics-old/x',
    '.claude', '.claude/worktreesx/a', '.claude/worktrees-old/a', '.claude/other/worktrees/x', 'src/a.ts', '.', 'worktrees/a']) {
    assert.equal(fenced(k), false, k)
  }
})

test('brackets are literal', () => {
  assert.equal(matches('app/[id]/*', 'app/[id]/page.tsx'), true)
  assert.equal(matches('app/[id]/*', 'app/i/page.tsx'), false, '[id] is not a class that reads i')
  assert.equal(matches('app/[id]/*', 'app/d/page.tsx'), false, '[id] is not a class that reads d')
  assert.equal(matches('app/[id]/*', 'app/[id]/x/page.tsx'), false, 'and the * stays in its segment')
  assert.equal(matches('[ab]', '[ab]'), true)
  for (const k of ['a', 'b', 'ab']) assert.equal(matches('[ab]', k), false, 'a [ab] glob is not a class: ' + k)
  assert.equal(matches('[!a]', 'b'), false, '[!a] is not a negated class')
  assert.equal(matches('[!a]', '[!a]'), true)
  assert.equal(matches('[a-c]', 'b'), false, '[a-c] is not a range')
  assert.equal(matches('[a-c]', '[a-c]'), true)
})

test('star stays in its segment', () => {
  assert.equal(matches('src/*.ts', 'src/a.ts'), true)
  assert.equal(matches('src/*.ts', 'src/x/a.ts'), false)
  assert.equal(matches('src/*.ts', 'src/a.tsx'), false, 'a glob matches whole keys')
  assert.equal(matches('src/*.ts', 'lib/src/a.ts'), false, 'a glob matches whole keys, from the start')
  assert.equal(matches('*.ts', 'a.ts'), true)
  assert.equal(matches('*.ts', 'x/a.ts'), false)
  assert.equal(matches('src/*/x.ts', 'src/a/x.ts'), true)
  assert.equal(matches('src/*/x.ts', 'src/a/b/x.ts'), false)
  assert.equal(matches('src/*/x.ts', 'src/x.ts'), false, 'a lone * is a segment, not zero directories')
})

test('double star crosses zero or more directories', () => {
  for (const k of ['src/index.ts', 'src/a/index.ts', 'src/a/b/index.ts']) assert.equal(matches('src/**/index.ts', k), true, k)
  for (const k of ['src/index.tsx', 'src/aindex.ts', 'src/a/xindex.ts', 'lib/src/index.ts', 'src/a/index.ts/b']) {
    assert.equal(matches('src/**/index.ts', k), false, k)
  }
  for (const k of ['index.ts', 'a/index.ts', 'a/b/index.ts']) assert.equal(matches('**/index.ts', k), true, k)
  for (const k of ['aindex.ts', 'index.tsx', 'a/xindex.ts']) assert.equal(matches('**/index.ts', k), false, k)
  for (const k of ['src/a', 'src/a/b/c.ts']) assert.equal(matches('src/**', k), true, k)
  for (const k of ['srcx/a', 'lib/src/a']) assert.equal(matches('src/**', k), false, k)
  assert.equal(matches('x/y/**/z/*.ts', 'x/y/m/n/z/q.ts'), true)
  assert.equal(matches('x/y/**/z/*.ts', 'x/y/z/q.ts'), true)
  assert.equal(matches('x/y/**/z/*.ts', 'x/y/z/q/r.ts'), false)
})

test('a lone double star is total', () => {
  const g = globOf('**')
  for (const k of ['a', 'a/b/c', '.hidden/x', 'my dir/ü.ts', ...KEYS]) assert.equal(g.re.test(k), true, k)
  assert.equal(g.total, true)
  assert.equal(g.base, '.')
})

test('base and total', () => {
  const table = [
    ['src/**', 'src', true],
    ['src/**/index.ts', 'src', false],
    ['**', '.', true],
    ['**/*.ts', '.', false],
    ['src/*.ts', 'src', false],
    ['src/*', 'src', false],
    ['*.ts', '.', false],
    ['a/b/c/**', 'a/b/c', true],
    ['a/b/*/c.ts', 'a/b', false],
    ['app/[id]/*', 'app/[id]', false],
    ['{a,b}/*', '{a,b}', false],
    ['src/a?c/x', 'src', false],
  ]
  for (const [glob, base, total] of table) {
    const g = globOf(glob)
    assert.deepEqual([g.base, g.total], [base, total], glob)
  }
})

test('question mark is one non-slash character', () => {
  assert.equal(matches('a?c', 'abc'), true)
  assert.equal(matches('a?c', 'a-c'), true)
  assert.equal(matches('a?c', 'aéc'), true)
  assert.equal(matches('a?c', 'a/c'), false)
  assert.equal(matches('a?c', 'abbc'), false)
  assert.equal(matches('a?c', 'ac'), false, 'one character, not zero')
  assert.equal(matches('src/?', 'src/a'), true)
  assert.equal(matches('src/?', 'src/ab'), false)
})

test('braces are literal', () => {
  assert.equal(matches('{a,b}.ts', '{a,b}.ts'), true)
  for (const k of ['a.ts', 'b.ts', 'a,b.ts', '{a,b}x.ts', 'x{a,b}.ts']) assert.equal(matches('{a,b}.ts', k), false, k)
})

test('regex metacharacters are literal', () => {
  const re = globOf('a.b+c(d)').re
  assert.equal(re.test('a.b+c(d)'), true)
  for (const k of ['axb+c(d)', 'a.bbc(d)', 'a.b+cd', 'a.b+c(d', 'a.bc(d)', 'a.b+c(d)x', 'xa.b+c(d)']) assert.equal(re.test(k), false, k)
  for (const ch of ['.', '+', '^', '$', '(', ')', '|', '{', '}', '[', ']', '\\', '-', ',', '!', '#', '(?:', '\\d']) {
    const glob = 'x' + ch + 'y'
    for (const k of ['xy', 'xzy', 'x', 'y', 'x/y']) assert.equal(matches(glob, k), false, JSON.stringify(glob) + ' is not ' + JSON.stringify(k))
    assert.equal(matches(glob, glob), true, JSON.stringify(glob) + ' is itself')
  }
})

test('no glob text throws, and a glob without a wildcard matches exactly itself', () => {
  for (const glob of ['[', ']', '[a', '(', ')', '{', '}', '\\', 'a\\', '+', '^', '$', '|', '(?:a)', 'a{', '.', '..', '-', 'a b', '*[', '[*', '**[', '[**]']) {
    const g = globOf(glob)
    assert.ok(g.re instanceof RegExp, glob)
    assert.equal(typeof g.base, 'string', glob)
    assert.equal(typeof g.total, 'boolean', glob)
    if (!/[*?]/.test(glob)) {
      assert.equal(g.re.test(glob), true, JSON.stringify(glob) + ' matches itself')
      assert.equal(g.re.test(glob + 'x'), false, JSON.stringify(glob) + ' matches whole keys')
    }
  }
})

test('a glob answers the same each time it is asked', () => {
  for (const glob of GLOBS) {
    const { re } = globOf(glob)
    for (const k of KEYS) assert.equal(re.test(k), re.test(k), glob + ' on ' + k)
  }
})

test('every key a glob matches lies under its base, so enumerating from the base misses none', () => {
  for (const glob of GLOBS) {
    const { re, base } = globOf(glob)
    assert.ok(!/[*?]/.test(base), glob + ': the base holds no wildcard, got ' + base)
    if (base !== '.') assert.ok(glob.startsWith(base + '/'), glob + ' begins with its base ' + base)
    for (const k of KEYS.filter((key) => re.test(key))) {
      assert.ok(base === '.' || k === base || k.startsWith(base + '/'), glob + ' matches ' + k + ' outside its base ' + base)
    }
  }
})

test('a total glob is exactly its base and ** and matches every key under it', () => {
  let seen = 0
  for (const glob of GLOBS) {
    const { re, base, total } = globOf(glob)
    assert.equal(total, glob === (base === '.' ? '**' : base + '/**'), glob + ' is total only when it is <base>/**')
    if (!total) continue
    seen++
    for (const k of KEYS.filter((key) => base === '.' || key.startsWith(base + '/'))) assert.equal(re.test(k), true, glob + ' on ' + k)
  }
  assert.ok(seen >= 2, 'the corpus holds a total glob at the root and one below it')
})

test('the dialect is stated', () => {
  assert.equal(typeof GLOB_RULES, 'string')
  assert.ok(GLOB_RULES.length > 0)
  for (const token of ['*', '**', '?']) assert.ok(GLOB_RULES.includes(token), 'GLOB_RULES names ' + token)
  assert.ok(/bracket/i.test(GLOB_RULES), 'GLOB_RULES says brackets are literal, the point a model reading git globs gets wrong')
})
