// test/fast/permissions.test.mjs — what each role may write, and the permission rules that say so.
//
// What is pinned here:
//
//   writesOf           which rule a producer round writes by: a red's test-author writes like any
//                      writer, a cycle's test round and a tests-only leaf only tests, a green's
//                      implementer and an auditor no tests
//   rolePermissions    the worktree by that rule, never `.agentics/`, Read denials, Bash rules and GIT_DENY
//   roleAdmits         the series' role check agrees with the rules path for path
//   writePermissions   exactly the listed files, their glob characters literal
//   TEST_PATTERNS      one table: every name an entry matches is a test path the rules treat as one;
//                      a name no entry matches is neither
//
// Design: docs/DESIGN.md#role-rules.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { GIT_DENY, roleAdmits, rolePermissions, writePermissions, writesOf } from '../../lib/permissions.mjs'
import { TEST_PATTERNS, isTestPath } from '../../lib/store.mjs'

/** A permission pattern as the host reads it, gitignore-style: `**` spans folders, `*` stays in one, `[..]` is one of a set. */
const globMatches = (pattern, path) => {
  const body = pattern.replace(/^\//, '').replace(/\*\*\/|\*\*|\*|\[[^\]]*\]|\\.|./g, (t) =>
    t === '**/' ? '(?:.*/)?' : t === '**' ? '.*' : t === '*' ? '[^/]*' : t.startsWith('[') ? t
      : t.slice(-1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp('^' + body + '$').test(path)
}
const edits = (rules, path) => rules.filter((r) => r.startsWith('Edit(')).some((r) => globMatches(r.slice('Edit('.length, -1), path))
/** Whether rules let a call edit `path`: an allow reaches it and no deny does, as the host decides. */
const may = ({ allowed, disallowed }, path) => edits(allowed, path) && !edits(disallowed, path)

/** A name a glob matches: each `*` as `fill`, each letter set as its first member, or its last when `last`. */
const nameOf = (glob, last = false, fill = '0') =>
  glob.replace(/\*/g, fill).replace(/\[([^\]]*)\]/g, (_, set) => (last ? set.slice(-1) : set[0]))
/** The names an entry matches: one per spelling its letter sets allow, each `*` as a digit or as dotted, dashed text. */
const namesOf = ({ glob }) =>
  [...new Set([false, true].flatMap((last) => ['0', 'a-1.min'].map((fill) => nameOf(glob, last, fill))))]
/** Names one step from an entry's: the first letter dropped, and lower case for a glob with no letter sets. */
const nearMisses = ({ glob }) => [false, true].map((last) => nameOf(glob, last)).flatMap((name) =>
  [name.replace(/[a-z]/i, ''), ...(glob.includes('[') ? [] : [name.toLowerCase()])])
/** Every path the table's entry names, at the root and deep in a tree. */
const pathsOf = (entry) => namesOf(entry).flatMap((name) => ['', 'src/deep/'].map((dir) => dir + name + (entry.folder ? '/0.js' : '')))

const WRITES = ['all', 'tests', 'no-tests']
const SOURCES = ['src/a/X.ts', 'package.json', 'app/[slug]/page.tsx', 'lib/latest.js', 'docs/test-plan.md']
const TESTS = TEST_PATTERNS.flatMap(pathsOf)
const STORE = ['.agentics/config.json', '.agentics/e1/.state/events.jsonl', '.agentics/x.test.json']

test('each producer round writes by its role and its leaf', () => {
  const leaf = (role, rigor = role === 'none' ? 'tdd' : 'tdd-triad') => ({ role, rigor })
  assert.equal(writesOf('implementer', leaf('none')), 'all')
  assert.equal(writesOf('implementer', leaf('none', 'trivial')), 'all')
  assert.equal(writesOf('implementer', leaf('green')), 'no-tests', 'a green never touches the cycle\'s tests')
  assert.equal(writesOf('test-author', leaf('red')), 'all', 'a red writes the stubs its green builds')
  assert.equal(writesOf('test-author', leaf('green')), 'tests', 'a green\'s test round')
  assert.equal(writesOf('test-author', leaf('audit')), 'tests', 'an audit\'s test round')
  assert.equal(writesOf('test-author', leaf('none', 'tests-only')), 'tests')
  assert.equal(writesOf('auditor', leaf('audit')), 'no-tests')
})

test('a writer may change any file of its worktree but none of the store', () => {
  const rules = rolePermissions({ writes: 'all' })
  for (const path of [...SOURCES, ...TESTS]) assert.ok(may(rules, path), path)
  for (const path of STORE) assert.ok(!may(rules, path), path)
})

test('a producer barred from tests may change every other file', () => {
  const rules = rolePermissions({ writes: 'no-tests' })
  for (const path of SOURCES) assert.ok(may(rules, path), path)
  for (const path of [...TESTS, ...STORE]) assert.ok(!may(rules, path), path)
})

test('a test round may change test files only', () => {
  const rules = rolePermissions({ writes: 'tests' })
  for (const path of TESTS) assert.ok(may(rules, path), path)
  for (const path of [...SOURCES, ...STORE]) assert.ok(!may(rules, path), path)
})

test('the series check admits exactly what the rules let a call write', () => {
  for (const writes of WRITES) {
    const rules = rolePermissions({ writes })
    for (const path of [...SOURCES, ...TESTS, ...STORE]) assert.equal(roleAdmits(writes, path), may(rules, path), writes + ' ' + path)
  }
})

test('a call that writes listed files may write those and nothing else', () => {
  const rules = writePermissions(['.agentics/e1/api/DESIGN.md', 'app/[slug]/page.tsx'])
  assert.ok(may(rules, '.agentics/e1/api/DESIGN.md'))
  assert.ok(may(rules, 'app/[slug]/page.tsx'))
  assert.ok(!may(rules, 'app/s/page.tsx'), 'brackets are literal')
  assert.ok(!may(rules, '.agentics/e1/DESIGN.md'))
  assert.ok(!may(rules, 'src/a/X.ts'))
})

test('paths a call must not read are denied', () => {
  const denyRead = ['secrets/.env', 'docs/answer.md']
  const { allowed, disallowed } = rolePermissions({ denyRead })
  for (const path of denyRead) {
    assert.ok(disallowed.includes(`Read(/${path})`), path)
    assert.ok(!allowed.some((r) => r.startsWith('Read(')), path)
  }
})

test('commands become bash rules', () => {
  const commands = ['npm test', 'node']
  const some = rolePermissions({ commands })
  for (const command of commands) assert.ok(some.allowed.includes(`Bash(${command}:*)`), command)
  assert.ok(!some.allowed.includes('Bash'), 'a listed command is no licence for every command')
  const all = rolePermissions({ commands: ['*'] })
  assert.ok(all.allowed.includes('Bash'))
  assert.ok(!all.allowed.includes('Bash(*:*)'))
})

/** The deny and allow rules as the host reads a Bash rule: `:*` is a prefix, any other `*` stands for any text. */
const bashRuleMatches = (rule, command) => {
  const body = rule.slice('Bash('.length, -1)
  if (body.endsWith(':*')) return command.startsWith(body.slice(0, -2))
  return new RegExp('^' + body.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(command)
}

test('a git option that reaches past a worktree is denied wherever it stands in the command', () => {
  const reaching = [
    'git diff --output=x', 'git diff HEAD --output=../../x', 'git diff HEAD~1 HEAD --output x', 'git log -p --output=x',
    'git show --output=x', 'git commit --amend', 'git commit -a --amend', 'git commit -m "m" --amend --no-edit',
    'git -C ../other status', 'git --git-dir=../x log', 'git --work-tree=../x status',
  ]
  const harmless = ['git diff HEAD', 'git log -p', 'git show HEAD', 'git commit -m "plain"', 'git status']
  const { disallowed } = rolePermissions({ commands: ['git diff', 'git log', 'git show', 'git commit', 'git status'] })
  const denies = (command) => disallowed.some((r) => r.startsWith('Bash(') && bashRuleMatches(r, command))
  for (const command of reaching) assert.ok(denies(command), `${command} is not denied`)
  for (const command of harmless) assert.ok(!denies(command), `${command} is denied`)
})

test('git options that reach past a worktree are denied with any shell, and only then', () => {
  assert.ok(GIT_DENY.length > 0)
  for (const commands of [['npm test'], ['*']]) {
    const { disallowed } = rolePermissions({ commands })
    for (const rule of GIT_DENY) assert.ok(disallowed.includes(rule), `${commands}: ${rule}`)
  }
  const none = rolePermissions({})
  assert.deepEqual(none.allowed.filter((r) => r === 'Bash' || r.startsWith('Bash(')), [])
  for (const rule of GIT_DENY) assert.ok(!none.disallowed.includes(rule), rule)
})

test('no rule is listed twice', () => {
  for (const writes of WRITES) {
    const { allowed, disallowed } = rolePermissions({ writes, commands: ['npm test', 'npm test', 'node'], denyRead: ['a.md', 'a.md'] })
    assert.deepEqual(allowed, [...new Set(allowed)])
    assert.deepEqual(disallowed, [...new Set(disallowed)])
  }
})

// ---------------------------------------------------------------- one test-file table

test('every name an entry of the test-file table matches is a test path', () => {
  assert.ok(TESTS.length > TEST_PATTERNS.length)
  for (const entry of TEST_PATTERNS) {
    for (const name of namesOf(entry)) assert.ok(globMatches(entry.glob, name), `${entry.glob} names ${name}`)
  }
  for (const path of TESTS) assert.equal(isTestPath(path), true, path)
})

test('an entry with letter sets matches in either case, one without in its own case only', () => {
  const anyCase = TEST_PATTERNS.filter((t) => t.glob.includes('['))
  const ownCase = TEST_PATTERNS.filter((t) => !t.glob.includes('[') && /[a-z]/i.test(t.glob))
  assert.ok(anyCase.length > 0 && ownCase.length > 0)
  for (const entry of anyCase) {
    const [lower, upper] = [nameOf(entry.glob), nameOf(entry.glob, true)]
    assert.notEqual(lower, upper, entry.glob)
    for (const name of [lower, upper]) assert.equal(isTestPath('src/a/' + name + (entry.folder ? '/0.js' : '')), true, name)
  }
  for (const entry of ownCase) {
    const name = nameOf(entry.glob)
    assert.equal(isTestPath('src/a/' + name), true, name)
    assert.equal(isTestPath('src/a/' + name.toLowerCase()), false, name.toLowerCase())
  }
})

test('a name no entry of the test-file table matches is no test path, and the rules treat it as source', () => {
  const tests = rolePermissions({ writes: 'tests' })
  const barred = rolePermissions({ writes: 'no-tests' })
  const misses = TEST_PATTERNS.flatMap((entry) => nearMisses(entry).map((name) => ({ entry, name })))
  assert.ok(misses.length > TEST_PATTERNS.length)
  for (const { entry, name } of misses) {
    assert.ok(!TEST_PATTERNS.some((t) => globMatches(t.glob, name)), `${name} is matched by no entry`)
    const path = 'src/deep/' + name + (entry.folder ? '/0.js' : '')
    assert.equal(isTestPath(path), false, path)
    assert.ok(!may(tests, path), `${path} is no test to write`)
    assert.ok(may(barred, path), `${path} is source to write`)
  }
})

test('a file entry matches the last segment of a path, not a folder it sits under', () => {
  for (const entry of TEST_PATTERNS.filter((t) => !t.folder)) {
    for (const name of namesOf(entry)) {
      assert.equal(isTestPath('src/a/' + name), true, name)
      assert.equal(isTestPath('src/a/' + name + '/0.js'), false, `${name} as a folder`)
    }
  }
})
