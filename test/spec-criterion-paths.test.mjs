// test/spec-criterion-paths.test.mjs — pins the check that a producing task's criterion runs only
// paths that exist or that its locus admits, so a test the plan runs is in the plan's locus.
//
// Design: docs/DESIGN.md#the-locus.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { checkFolder, criterionPathProblems, locusDirectoryProblems } from '../lib/spec.mjs'
import { specPath } from '../lib/store.mjs'

const spec = (entries) => ({ file: 'DESIGN.md', entries })
const task = (locus, check, extra = {}) => ({
  name: 't', kind: 'task', rigor: 'tdd', locus, criteria: [{ text: 'c', check, line: 7 }], ...extra,
})
const none = () => false

test('a prefix of a listed file is admitted', () => {
  assert.deepEqual(criterionPathProblems(spec([task(['src/core/wishing/GroundSupply.ts'], 'npx vitest run src/core/wishing/GroundSupply')]), { isPrefix: none }), [])
})

test('a new test beside a listed file is admitted', () => {
  assert.deepEqual(criterionPathProblems(spec([task(['src/a/X.ts'], 'node --test src/a/X.test.mjs')]), { isPrefix: none }), [])
})

test('a path under a directory entry is admitted', () => {
  assert.deepEqual(criterionPathProblems(spec([task(['src/endless/'], 'npx vitest run src/endless/mode.test.ts')]), { isPrefix: none }), [])
})

test('an existing repository path is fine', () => {
  const isPrefix = (t) => 'test/other.test.mjs'.startsWith(t)
  assert.deepEqual(criterionPathProblems(spec([task(['src/a/X.ts'], 'node --test test/other.test.mjs')]), { isPrefix }), [])
})

test('a new test in an unlisted folder is a problem at its criterion line', () => {
  const out = criterionPathProblems(spec([task(['src/a/X.ts'], 'pytest tests/test_x.py')]), { isPrefix: none })
  assert.equal(out.length, 1)
  assert.equal(out[0].line, 7)
  assert.equal(out[0].file, 'DESIGN.md')
  assert.match(out[0].problem, /tests\/test_x\.py/)
})

test('flags, urls and words without a slash are not paths', () => {
  const check = 'npm test -- --reporter=dot https://example.com/x and words'
  assert.deepEqual(criterionPathProblems(spec([task(['src/a/X.ts'], check)]), { isPrefix: none }), [])
})

test('quoted paths are read without their quotes', () => {
  const out = criterionPathProblems(spec([task(['src/a/X.ts'], 'node --test "tests/y.test.mjs"')]), { isPrefix: none })
  assert.match(out[0].problem, /tests\/y\.test\.mjs/)
  assert.doesNotMatch(out[0].problem, /"tests/)
})

test('a verify task and a sub-effort are not checked', () => {
  const verify = task(['src/a/X.ts'], 'node --test tests/z.test.mjs', { rigor: 'verify' })
  const sub = { ...task([], 'node --test tests/z.test.mjs'), kind: 'sub-effort' }
  assert.deepEqual(criterionPathProblems(spec([verify, sub]), { isPrefix: none }), [])
})

test('a criterion with no check is not checked', () => {
  assert.deepEqual(criterionPathProblems(spec([task(['src/a/X.ts'], '')]), { isPrefix: none }), [])
})

test('a non-test file under a directory entry is admitted', () => {
  assert.deepEqual(criterionPathProblems(spec([task(['src/endless/'], 'node src/endless/run.mjs')]), { isPrefix: none }), [])
})

test('a flag that carries a path is not a path', () => {
  assert.deepEqual(criterionPathProblems(spec([task(['src/a/X.ts'], 'node --test --out=tmp/x.json')]), { isPrefix: none }), [])
})

test('a redirection is not a path', () => {
  const check = 'npm test 2>/dev/null >out/run.log <in/data.txt'
  assert.deepEqual(criterionPathProblems(spec([task(['src/a/X.ts'], check)]), { isPrefix: none }), [])
})

test('a glob, a variable or an operator glued to a path is not a path', () => {
  const check = 'npx vitest src/**/*.test.ts src/?.ts src/[ab].ts src/[a src/a]/b src/{a src/b} $OUT/x.log a|b/c a&b/c'
  assert.deepEqual(criterionPathProblems(spec([task(['src/a/X.ts'], check)]), { isPrefix: none }), [])
})

test('a trailing semicolon, comma or parenthesis is not part of the path', () => {
  const admitted = 'node --test src/a/X.test.mjs; node src/a/X.ts, (node src/a/X.ts)'
  assert.deepEqual(criterionPathProblems(spec([task(['src/a/X.ts'], admitted)]), { isPrefix: none }), [])
  const [out] = criterionPathProblems(spec([task(['src/a/X.ts'], 'pytest tests/test_x.py;')]), { isPrefix: none })
  assert.ok(out.problem.includes(' runs tests/test_x.py, which'), out.problem)
})

test('a path written from the current directory is read as the repository path it names', () => {
  const isPrefix = (t) => 'test/other.test.mjs'.startsWith(t)
  assert.deepEqual(criterionPathProblems(spec([task(['src/a/X.ts'], 'node --test ./test/other.test.mjs')]), { isPrefix }), [])
  assert.deepEqual(criterionPathProblems(spec([task(['src/a/X.ts'], 'node --test ././src/a/X.test.mjs')]), { isPrefix: none }), [])
})

test('the locus is checked before the repository is listed', () => {
  const isPrefix = () => { throw new Error('the repository was listed for a path the locus admits') }
  const check = 'node --test src/a/X.test.mjs src/a/X'
  assert.deepEqual(criterionPathProblems(spec([task(['src/a/X.ts'], check)]), { isPrefix }), [])
})

const SPEC = (check) => [
  '# Criterion paths', '', '## Intent', '', 'A plan\'s tests run inside its locus.', '', '## Decisions', '',
  '| id | decision | why |', '|---|---|---|', '| D1 | The runner runs what the plan lists. | A test outside the locus is never written. |',
  '', '## Design', '', 'Nothing more.', '', '## Plan', '',
  '- **runner** — task · realises: D1 · rigor: tdd · locus: src/a/X.ts', '  Build the runner',
  '  - [ ] it runs — check: `' + check + '`', '', '## Open questions', '', '## Evidence', '',
].join('\n')

/** An effort `e1` whose root spec's one criterion runs `check`; a git repository holding `files` when `git` is set. */
function effortWith(t, check, { git = false, files = {} } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'agentics-criterion-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  if (git) {
    const g = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
    g('init', '-q', '-b', 'main')
    g('config', 'user.email', 't@t'); g('config', 'user.name', 't')
    for (const [path, text] of Object.entries({ 'README.md': 'r\n', ...files })) {
      mkdirSync(dirname(join(repo, path)), { recursive: true })
      writeFileSync(join(repo, path), text)
    }
    g('add', '.'); g('commit', '-q', '-m', 'files')
  }
  mkdirSync(dirname(specPath(repo, 'e1', '.')), { recursive: true })
  writeFileSync(specPath(repo, 'e1', '.'), SPEC(check))
  return repo
}

const checkLine = SPEC('x').split('\n').findIndex((l) => l.includes('check:')) + 1

test('checkFolder reports a criterion path no file starts with and the locus does not admit', (t) => {
  const repo = effortWith(t, 'node --test tests/x.test.mjs', { git: true })
  const out = checkFolder(repo, 'e1', '.')
  assert.equal(out.problems.length, 1, JSON.stringify(out.problems))
  assert.equal(out.problems[0].file, out.file)
  assert.equal(out.problems[0].line, checkLine)
  assert.match(out.problems[0].problem, /tests\/x\.test\.mjs/)
})

test('checkFolder does not report a path the repository has', (t) => {
  const repo = effortWith(t, 'node --test tests/x.test.mjs', { git: true, files: { 'tests/x.test.mjs': 'x\n' } })
  assert.deepEqual(checkFolder(repo, 'e1', '.').problems, [])
})

test('checkFolder does not report a tracked path written from the current directory', (t) => {
  const repo = effortWith(t, 'node --test ./tests/x.test.mjs', { git: true, files: { 'tests/x.test.mjs': 'x\n' } })
  assert.deepEqual(checkFolder(repo, 'e1', '.').problems, [])
})

test('checkFolder outside git reports the unlisted path without throwing', (t) => {
  const repo = effortWith(t, 'node --test tests/x.test.mjs')
  const out = checkFolder(repo, 'e1', '.')
  assert.equal(out.problems.length, 1, JSON.stringify(out.problems))
  assert.equal(out.problems[0].line, checkLine)
})

test('checkFolder in a repository git cannot list reports the listing, not each path', (t) => {
  const repo = effortWith(t, 'node --test tests/x.test.mjs', { git: true })
  writeFileSync(join(repo, '.git', 'index'), 'not an index')
  const out = checkFolder(repo, 'e1', '.')
  assert.equal(out.problems.length, 1, JSON.stringify(out.problems))
  assert.match(out.problems[0].problem, /could not be listed/)
  assert.match(out.problems[0].problem, /ls-files/)
})

test('a locus entry naming a directory without its trailing slash is reported at its entry', () => {
  const isDir = (p) => p === 'src/game/assets'
  const out = locusDirectoryProblems(spec([task(['src/game/assets', 'src/game/assets/', 'src/a/X.ts'], '', { line: 3 })]), { isDir })
  assert.equal(out.length, 1, JSON.stringify(out))
  assert.equal(out[0].line, 3)
  assert.match(out[0].problem, /src\/game\/assets names a directory; write it with a trailing \/: src\/game\/assets\//)
})

test('checkFolder reports a locus entry that names a directory of the repository without a trailing slash', (t) => {
  const repo = effortWith(t, 'node src/a/X.ts', { git: true, files: { 'src/a/X.ts': 'x\n' } })
  writeFileSync(specPath(repo, 'e1', '.'), SPEC('node src/a/X.ts').replace('locus: src/a/X.ts', 'locus: src/a'))
  const out = checkFolder(repo, 'e1', '.')
  assert.equal(out.problems.length, 1, JSON.stringify(out.problems))
  assert.match(out.problems[0].problem, /src\/a names a directory/)
  writeFileSync(specPath(repo, 'e1', '.'), SPEC('node src/a/X.ts').replace('locus: src/a/X.ts', 'locus: src/a/'))
  assert.deepEqual(checkFolder(repo, 'e1', '.').problems, [])
})
