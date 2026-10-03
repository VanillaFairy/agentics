// test/commit-series-net.test.mjs — pins the series check's locus judged on the net diff, base to
// head (`netFiles`, `admits`), and `removedTestCases`, the removed-test-case finder.
//
// Design: docs/DESIGN.md#the-locus, docs/DESIGN.md#conversations.
//
// Findings are compared as sorted `check` lists and by the files their messages name, never by
// wording or order. The modules are imported as namespaces so the tests pinning unchanged
// behaviour run before the new exports exist.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as series from '../lib/commit-series.mjs'
import * as store from '../lib/store.mjs'

const SHA_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const SHA_B = 'b2c3d4e5f60718293a4b5c6d7e8f90123456789a'
const SHA_C = 'c3d4e5f60718293a4b5c6d7e8f90123456789ab1'

const LOCUS = ['lib/x.mjs', 'test/x.test.mjs']
const STRAY = 'notes/stray.txt'

const commit = (sha, subject, files) => ({ sha, subject, trailers: '', files })

const checksOf = (findings) => findings.map((f) => f.check).sort()
const breaches = (findings) => findings.filter((f) => f.check === 'locus-breach')
const naming = (findings, file) => findings.filter((f) => String(f.message).includes(file))

/** The new export, failing with a readable message while it is missing. */
function removedTestCases(approved, head) {
  assert.equal(typeof series.removedTestCases, 'function', 'lib/commit-series.mjs exports no removedTestCases')
  return series.removedTestCases(approved, head)
}

/** An `admits` fake that accepts the given paths whether it is called with a path or `{path}`. */
const admitsOnly = (accepted) => (...args) =>
  args.some((a) => accepted.includes(typeof a === 'string' ? a : a && a.path))

// =========================================================================================
// analyzeSeries with a net diff
// =========================================================================================

test('a stray file taken out again is no breach', () => {
  const commits = [
    commit(SHA_A, 'feat(x): add the parser', ['lib/x.mjs', STRAY]),
    commit(SHA_B, 'chore(x): drop the stray file', [STRAY]),
  ]
  const findings = series.analyzeSeries(commits, LOCUS, {}, { netFiles: ['lib/x.mjs'] })
  assert.deepEqual(breaches(findings), [])
  assert.deepEqual(naming(findings, STRAY), [], 'no finding of any kind names the reverted file')
})

test('a stray file left in the net diff is one breach', () => {
  const commits = [
    commit(SHA_A, 'feat(x): add the parser', ['lib/x.mjs', STRAY]),
    commit(SHA_B, 'fix(x): tune the parser', ['lib/x.mjs', STRAY]),
  ]
  const findings = series.analyzeSeries(commits, LOCUS, {}, { netFiles: ['lib/x.mjs', STRAY] })
  const hits = breaches(findings)
  assert.equal(hits.length, 1, 'one breach per stray file in the net diff, not one per commit')
  assert.ok(hits[0].message.includes(STRAY), 'the breach names the stray file')
  assert.equal(hits[0].blocking, true)
  assert.deepEqual(naming(hits, 'lib/x.mjs'), [], 'a locus file is never a breach')
})

test('what admits accepts is no breach', () => {
  const besideTest = 'lib/x.test.mjs'
  const commits = [commit(SHA_A, 'feat(x): add the parser', ['lib/x.mjs', besideTest, STRAY])]
  const admits = admitsOnly([...LOCUS, besideTest])
  const findings = series.analyzeSeries(commits, LOCUS, {}, {
    netFiles: ['lib/x.mjs', besideTest, STRAY], admits,
  })
  const hits = breaches(findings)
  assert.deepEqual(naming(hits, besideTest), [], 'a file admits accepts is no breach')
  assert.equal(hits.length, 1, 'a file admits rejects is still a breach')
  assert.ok(hits[0].message.includes(STRAY))
})

test('a fenced commit is still held to its fence', () => {
  // SHA_A is a test-author round fenced to the test file; it also wrote the source file, which
  // the leaf's locus lists and the net diff therefore clears. SHA_B and SHA_C add and take out a
  // stray file the net diff clears too.
  const commits = [
    commit(SHA_A, 'test(x): pin the parser', ['test/x.test.mjs', 'lib/x.mjs']),
    commit(SHA_B, 'feat(x): add the parser', ['lib/x.mjs', STRAY]),
    commit(SHA_C, 'chore(x): drop the stray file', [STRAY]),
  ]
  const fences = { [SHA_A]: ['test/x.test.mjs'] }
  const findings = series.analyzeSeries(commits, LOCUS, fences, { netFiles: ['lib/x.mjs', 'test/x.test.mjs'] })
  const hits = breaches(findings)
  assert.equal(hits.length, 1, 'only the fenced commit breaches')
  assert.equal(hits[0].sha, SHA_A)
  assert.ok(hits[0].message.includes('lib/x.mjs'), 'the breach names the file outside the fence')
  assert.deepEqual(naming(hits, STRAY), [])
})

test('without a net diff each commit is held to the locus', () => {
  const commits = [
    commit(SHA_A, 'feat(x): add the parser', ['lib/x.mjs', STRAY]),
    commit(SHA_B, 'chore(x): drop the stray file', [STRAY]),
  ]
  for (const findings of [
    series.analyzeSeries(commits, LOCUS),
    series.analyzeSeries(commits, LOCUS, {}),
    series.analyzeSeries(commits, LOCUS, {}, {}),
    series.analyzeSeries(commits, LOCUS, {}, { netFiles: null }),
  ]) {
    const hits = breaches(findings)
    for (const sha of [SHA_A, SHA_B]) {
      const own = hits.filter((f) => f.sha === sha)
      assert.equal(own.length, 1, `commit ${sha} breaches once`)
      assert.ok(own[0].message.includes(STRAY))
    }
    assert.equal(hits.length, 2)
  }
})

test('the other series checks still run', () => {
  const commits = [
    commit(SHA_A, 'wip parser', ['lib/x.mjs']),
    commit(SHA_B, 'feat(x): add the parser', []),
    commit(SHA_C, 'feat(x): add the parser and the tests', ['lib/x.mjs', 'test/x.test.mjs']),
  ]
  const expected = ['and-subject', 'empty-commit', 'wip-subject']
  const findings = series.analyzeSeries(commits, LOCUS, {}, { netFiles: ['lib/x.mjs', 'test/x.test.mjs'] })
  assert.deepEqual(checksOf(findings), expected)
  const bySha = Object.fromEntries(findings.map((f) => [f.check, f.sha]))
  assert.deepEqual(bySha, { 'wip-subject': SHA_A, 'empty-commit': SHA_B, 'and-subject': SHA_C })
})

// =========================================================================================
// removedTestCases
// =========================================================================================

const lines = (...ls) => ls.join('\n') + '\n'
const crlf = (text) => text.replace(/\n/g, '\r\n')

const APPROVED = lines(
  "import { test } from 'node:test'",
  '',
  "  test('parses one record', () => {",
  '    assert.equal(parse(one).length, 1)',
  '  })',
  '',
  "  test('parses two records', () => {",
  '    assert.equal(parse(two).length, 2)',
  '  })',
)

test('a removed test case is named', () => {
  const head = lines(
    "import { test } from 'node:test'",
    '',
    "  test('parses one record', () => {",
    '    assert.equal(parse(one).length, 1)',
    '  })',
  )
  const removed = "test('parses two records', () => {"
  for (const [approved, h] of [[APPROVED, head], [crlf(APPROVED), crlf(head)]]) {
    const got = removedTestCases(approved, h)
    assert.deepEqual(got, [removed], 'only the declaration line, trimmed; not its body')
  }
})

test('a renamed test case counts as removed', () => {
  const head = APPROVED.replace("'parses two records'", "'parses a pair of records'")
  const got = removedTestCases(APPROVED, head)
  assert.deepEqual(got, ["test('parses two records', () => {"])
})

test('an added test case is not a removal', () => {
  const head = APPROVED + lines(
    '',
    "  test('parses three records', () => {",
    '    assert.equal(parse(three).length, 3)',
    '  })',
  )
  assert.deepEqual(removedTestCases(APPROVED, head), [])
})

test('nothing removed is nothing', () => {
  assert.deepEqual(removedTestCases(APPROVED, APPROVED), [])
  assert.deepEqual(removedTestCases(crlf(APPROVED), crlf(APPROVED)), [])
  assert.deepEqual(removedTestCases('', ''), [])
})

test('removals are found in other languages', () => {
  const py = lines(
    'def test_one():',
    '    assert parse(one) == 1',
    '',
    'def test_x(tmp_path):',
    '    assert parse(two) == 2',
  )
  const pyHead = lines('def test_one():', '    assert parse(one) == 1')
  assert.deepEqual(removedTestCases(py, pyHead), ['def test_x(tmp_path):'])

  const go = lines(
    'func TestOne(t *testing.T) {',
    '\tif Parse(one) != 1 { t.Fatal() }',
    '}',
    '',
    'func TestX(t *testing.T) {',
    '\tif Parse(two) != 2 { t.Fatal() }',
    '}',
  )
  const goHead = lines('func TestOne(t *testing.T) {', '\tif Parse(one) != 1 { t.Fatal() }', '}')
  assert.deepEqual(removedTestCases(go, goHead), ['func TestX(t *testing.T) {'])
})

test('a moved test case is not a removal', () => {
  const head = lines(
    "import { test } from 'node:test'",
    '',
    "test('parses two records', () => {",
    '  assert.equal(parse(two).length, 2)',
    '})',
    '',
    "test('parses one record', () => {",
    '  assert.equal(parse(one).length, 1)',
    '})',
  )
  assert.deepEqual(removedTestCases(APPROVED, head), [])
})

test('the test-case patterns are shared', () => {
  assert.equal(typeof store.isTestPath, 'function')
  const patterns = store.TEST_CASE_PATTERNS
  assert.ok(Array.isArray(patterns), 'lib/store.mjs exports TEST_CASE_PATTERNS as an array')
  assert.ok(patterns.length > 0)
  for (const re of patterns) assert.ok(re instanceof RegExp, `${re} is a regular expression`)
  for (const declaration of ["it('works', () => {", 'def test_x():', 'func TestX(t *testing.T) {']) {
    assert.ok(patterns.some((re) => re.test(declaration)), `a pattern matches ${declaration}`)
  }
})
