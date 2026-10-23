// test/fast/commit-series-net.test.mjs — pins the series check's role rule judged on the net diff,
// base to head (`netFiles`), with fenced commits judged per commit; and `removedTestCases`, the
// removed-test-case finder.
//
// Design: docs/DESIGN.md#role-rules, docs/DESIGN.md#conversations.
//
// Findings are compared as sorted `check` lists and by the files their messages name, never by
// wording or order.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as series from '../../lib/commit-series.mjs'
import * as store from '../../lib/store.mjs'

const SHA_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const SHA_B = 'b2c3d4e5f60718293a4b5c6d7e8f90123456789a'
const SHA_C = 'c3d4e5f60718293a4b5c6d7e8f90123456789ab1'

const TEST_FILE = 'test/x.test.mjs'

const commit = (sha, subject, files) => ({ sha, subject, trailers: '', files })

const checksOf = (findings) => findings.map((f) => f.check).sort()
const breaches = (findings) => findings.filter((f) => f.check === 'role-breach')
const naming = (findings, file) => findings.filter((f) => String(f.message).includes(file))

/** The new export, failing with a readable message while it is missing. */
function removedTestCases(approved, head) {
  assert.equal(typeof series.removedTestCases, 'function', 'lib/commit-series.mjs exports no removedTestCases')
  return series.removedTestCases(approved, head)
}

// =========================================================================================
// analyzeSeries with a net diff
// =========================================================================================

test('a test a green touched and put back is no breach', () => {
  const commits = [
    commit(SHA_A, 'feat(x): add the parser', ['lib/x.mjs', TEST_FILE]),
    commit(SHA_B, 'chore(x): restore the test', [TEST_FILE]),
  ]
  const findings = series.analyzeSeries(commits, { writes: 'no-tests', netFiles: ['lib/x.mjs'] })
  assert.deepEqual(breaches(findings), [])
  assert.deepEqual(naming(findings, TEST_FILE), [], 'no finding of any kind names the restored file')
})

test('a test left in the net diff of a green is one breach', () => {
  const commits = [
    commit(SHA_A, 'feat(x): add the parser', ['lib/x.mjs', TEST_FILE]),
    commit(SHA_B, 'fix(x): tune the parser', ['lib/x.mjs', TEST_FILE]),
  ]
  const findings = series.analyzeSeries(commits, { writes: 'no-tests', netFiles: ['lib/x.mjs', TEST_FILE] })
  const hits = breaches(findings)
  assert.equal(hits.length, 1, 'one breach per file in the net diff, not one per commit')
  assert.ok(hits[0].message.includes(TEST_FILE), 'the breach names the test file')
  assert.equal(hits[0].blocking, true)
  assert.deepEqual(naming(hits, 'lib/x.mjs'), [], 'a source file is never a green\'s breach')
})

test('a fenced commit is still held to its fence', () => {
  // SHA_A is a test round on a green, fenced to tests; it also wrote the source file, which the
  // green may write and the net diff therefore clears.
  const commits = [
    commit(SHA_A, 'test(x): pin the parser', [TEST_FILE, 'lib/x.mjs']),
    commit(SHA_B, 'feat(x): add the parser', ['lib/x.mjs']),
  ]
  const findings = series.analyzeSeries(commits, { writes: 'no-tests', fences: { [SHA_A]: 'tests' }, netFiles: ['lib/x.mjs', TEST_FILE] })
  const hits = breaches(findings)
  assert.equal(hits.length, 1, 'only the fenced commit breaches')
  assert.equal(hits[0].sha, SHA_A)
  assert.ok(hits[0].message.includes('lib/x.mjs'), 'the breach names the file outside the fence')
})

test('without a net diff each commit is held to the rule', () => {
  const commits = [
    commit(SHA_A, 'feat(x): add the parser', ['lib/x.mjs', TEST_FILE]),
    commit(SHA_B, 'chore(x): restore the test', [TEST_FILE]),
  ]
  for (const findings of [
    series.analyzeSeries(commits, { writes: 'no-tests' }),
    series.analyzeSeries(commits, { writes: 'no-tests', netFiles: null }),
  ]) {
    const hits = breaches(findings)
    for (const sha of [SHA_A, SHA_B]) {
      const own = hits.filter((f) => f.sha === sha)
      assert.equal(own.length, 1, `commit ${sha} breaches once`)
      assert.ok(own[0].message.includes(TEST_FILE))
    }
    assert.equal(hits.length, 2)
  }
})

test('the other series checks still run', () => {
  const commits = [
    commit(SHA_A, 'wip parser', ['lib/x.mjs']),
    commit(SHA_B, 'feat(x): add the parser', []),
    commit(SHA_C, 'feat(x): add the parser and the tests', ['lib/x.mjs', TEST_FILE]),
  ]
  const expected = ['and-subject', 'empty-commit', 'wip-subject']
  const findings = series.analyzeSeries(commits, { netFiles: ['lib/x.mjs', TEST_FILE] })
  assert.deepEqual(checksOf(findings), expected)
  const bySha = Object.fromEntries(findings.map((f) => [f.check, f.sha]))
  assert.deepEqual(bySha, { 'wip-subject': SHA_A, 'empty-commit': SHA_B, 'and-subject': SHA_C })
})

test('a file only fenced commits touched is not judged on the net diff', () => {
  // SHA_A is a test round fenced to tests; the green may not write the test, so judging it on the
  // net diff would breach a file the fence allows.
  const commits = [
    commit(SHA_A, 'test(x): pin the parser', [TEST_FILE]),
    commit(SHA_B, 'feat(x): add the parser', ['lib/x.mjs']),
  ]
  const findings = series.analyzeSeries(commits, { writes: 'no-tests', fences: { [SHA_A]: 'tests' }, netFiles: ['lib/x.mjs', TEST_FILE] })
  assert.deepEqual(breaches(findings), [], 'the fenced commit alone touched the file: its fence judges it')
  assert.deepEqual(naming(findings, TEST_FILE), [])
})

test('an unfenced commit touching a file a fenced commit touched is judged by the leaf\'s rule', () => {
  const commits = [
    commit(SHA_A, 'test(x): pin the parser', [TEST_FILE]),
    commit(SHA_B, 'fix(x): change the parser test', [TEST_FILE]),
  ]
  const fences = { [SHA_A]: 'tests' }
  // netFiles lacks the file: the net diff of a file changed and changed back holds nothing.
  const green = breaches(series.analyzeSeries(commits, { writes: 'no-tests', fences, netFiles: [] }))
  assert.equal(green.length, 1, 'one breach: the unfenced commit; the fenced one is within its fence')
  assert.equal(green[0].sha, SHA_B)
  assert.ok(green[0].message.includes(TEST_FILE), 'the breach names the file')

  assert.deepEqual(breaches(series.analyzeSeries(commits, { writes: 'all', fences, netFiles: [] })), [],
    'a role that may write the file breaches nothing, fenced file or not')
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

test('removing one of two identical declarations is a removal', () => {
  const declaration = "test('parses one record', () => {"
  const copy = lines('', '  ' + declaration, '    assert.equal(parse(one).length, 1)', '  })')
  const twice = "import { test } from 'node:test'\n" + copy + copy
  const once = "import { test } from 'node:test'\n" + copy
  const never = "import { test } from 'node:test'\n"
  assert.deepEqual(removedTestCases(twice, once), [declaration], 'the head keeps one copy: one is gone')
  assert.deepEqual(removedTestCases(twice, never), [declaration, declaration], 'the head keeps none: both are gone')
  assert.deepEqual(removedTestCases(twice, twice), [])
  assert.deepEqual(removedTestCases(once, twice), [], 'an extra copy at the head removes nothing')
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
