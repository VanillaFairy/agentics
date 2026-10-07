// test/locus.test.mjs — what a leaf's locus admits, and the permission rules it becomes.
//
// What is pinned here:
//
//   admits          listed files, directory entries, new tests beside a listed file; never a held
//                   file, an existing unlisted test, a test beside a root file, or any test for a
//                   producer barred from tests
//   permissionsFor  Edit/Write per entry, test globs per listed folder, the denials for held,
//                   existing unlisted and barred tests, Read denials, Bash rules and GIT_DENY
//   TEST_PATTERNS   one table: every name an entry matches is a test path and gets a test glob,
//                   in each case the entry spells; a name no entry matches gets neither
//
// Design: docs/DESIGN.md#the-locus.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { GIT_DENY, TEST_GLOBS, admits, permissionsFor } from '../lib/locus.mjs'
import { TEST_PATTERNS, isTestPath } from '../lib/store.mjs'

const editWrite = (target) => [`Edit(${target})`, `Write(${target})`]
const dirOf = (path) => path.slice(0, path.lastIndexOf('/'))
const count = (list, item) => list.filter((x) => x === item).length
const sorted = (list) => [...list].sort()
const TEST_FOLDERS = TEST_PATTERNS.filter((t) => t.folder).map((t) => t.glob)

test('a listed file is admitted', () => {
  const locus = ['src/a/X.ts', 'src/a/New.ts']
  assert.equal(admits({ locus, path: 'src/a/X.ts', baseFiles: ['src/a/X.ts'] }), true)
  assert.equal(admits({ locus, path: 'src/a/New.ts', baseFiles: ['src/a/X.ts'] }), true)
  assert.equal(admits({ locus, path: 'src/a/New.ts' }), true)
})

test('a directory entry admits what is under it', () => {
  const locus = ['src/b/']
  assert.equal(admits({ locus, path: 'src/b/y.ts' }), true)
  assert.equal(admits({ locus, path: 'src/b/deep/er/z.ts', baseFiles: ['src/b/deep/er/z.ts'] }), true)
  assert.equal(admits({ locus, path: 'src/bx/y.ts' }), false, 'a sibling sharing the prefix is not under it')
})

test('a new test beside a listed file is admitted', () => {
  const locus = ['src/a/X.ts']
  const baseFiles = ['src/a/X.ts']
  assert.equal(admits({ locus, path: 'src/a/X.test.ts', baseFiles }), true)
  assert.equal(admits({ locus, path: 'src/a/X.spec.ts', baseFiles }), true)
})

test('any new test name in a listed file\'s folder is admitted', () => {
  const locus = ['pkg/bar.go']
  const baseFiles = ['pkg/bar.go']
  assert.equal(admits({ locus, path: 'pkg/foo_test.go', baseFiles }), true)
  assert.equal(admits({ locus, path: 'pkg/test_other.py', baseFiles }), true)
  assert.equal(admits({ locus, path: 'pkg/WidgetTest.java', baseFiles }), true)
})

test('a new non-test beside a listed file is not admitted', () => {
  const locus = ['src/a/X.ts']
  const baseFiles = ['src/a/X.ts']
  assert.equal(admits({ locus, path: 'src/a/X.helpers.ts', baseFiles }), false)
  assert.equal(admits({ locus, path: 'src/a/Y.ts', baseFiles }), false)
})

test('an existing unlisted test is not admitted', () => {
  const locus = ['src/a/X.ts']
  const baseFiles = ['src/a/X.ts', 'src/a/X.test.ts']
  assert.equal(admits({ locus, path: 'src/a/X.test.ts', baseFiles }), false)
  assert.equal(admits({ locus: [...locus, 'src/a/X.test.ts'], path: 'src/a/X.test.ts', baseFiles }), true,
    'listing it admits it again')
})

test('nothing is admitted beside a root file', () => {
  const locus = ['index.mjs']
  const baseFiles = ['index.mjs']
  for (const path of ['index.test.mjs', 'foo_test.mjs', 'test_index.mjs', 'IndexSpec.mjs']) {
    assert.equal(admits({ locus, path, baseFiles }), false, path)
  }
  assert.equal(admits({ locus, path: 'index.mjs', baseFiles }), true, 'the root file itself stays admitted')
})

test('a held file is never admitted', () => {
  assert.equal(admits({ locus: ['src/a/X.ts'], path: 'src/a/X.ts', held: ['src/a/X.ts'] }), false)
  assert.equal(admits({ locus: ['src/b/'], path: 'src/b/y.ts', held: ['src/b/y.ts'] }), false)
  assert.equal(admits({ locus: ['src/a/X.ts'], path: 'src/a/X.test.ts', baseFiles: ['src/a/X.ts'],
    held: ['src/a/X.test.ts'] }), false)
  assert.equal(admits({ locus: ['src/a/X.ts'], path: 'src/a/X.ts', held: ['src/c/Z.ts'] }), true,
    'a hold elsewhere bars nothing here')
})

test('a producer barred from tests is admitted none', () => {
  const tests = false
  const baseFiles = ['src/a/X.ts']
  assert.equal(admits({ locus: ['src/a/X.ts'], path: 'src/a/X.test.ts', baseFiles, tests }), false, 'beside')
  assert.equal(admits({ locus: ['src/a/X.ts', 'src/a/X.test.ts'], path: 'src/a/X.test.ts', baseFiles, tests }),
    false, 'listed')
  assert.equal(admits({ locus: ['src/b/'], path: 'src/b/Y.test.ts', tests }), false, 'under a directory entry')
  assert.equal(admits({ locus: ['src/b/'], path: 'src/b/test/fixture.json', tests }), false, 'in a test folder')
  assert.equal(admits({ locus: ['src/a/X.ts'], path: 'src/a/X.ts', baseFiles, tests }), true,
    'its non-test files stay admitted')
  assert.equal(admits({ locus: ['src/b/'], path: 'src/b/y.ts', tests }), true)
})

test('an unrelated file is not admitted', () => {
  const locus = ['src/a/X.ts', 'src/b/']
  const baseFiles = ['src/a/X.ts', 'lib/other.mjs']
  assert.equal(admits({ locus, path: 'lib/other.mjs', baseFiles }), false)
  assert.equal(admits({ locus, path: 'lib/new.mjs', baseFiles }), false)
  assert.equal(admits({ locus, path: 'src/c/X.test.ts', baseFiles }), false, 'a test in another folder')
  assert.equal(admits({ locus: [], path: 'src/a/X.ts', baseFiles }), false)
})

test('a listed file becomes edit and write rules', () => {
  const locus = ['src/a/X.ts', 'lib/y.mjs']
  const { allowed } = permissionsFor({ locus, baseFiles: ['src/a/X.ts'] })
  for (const file of locus) {
    for (const rule of editWrite(file)) assert.ok(allowed.includes(rule), rule)
  }
})

test('a root-level file is anchored to the root, so it never reaches a file of the same name deeper down', () => {
  const { allowed, disallowed } = permissionsFor({ locus: ['package.json', 'src/a/X.ts'], held: ['README.md'], denyRead: ['.env'] })
  for (const rule of editWrite('/package.json')) assert.ok(allowed.includes(rule), rule)
  for (const rule of editWrite('package.json')) assert.ok(!allowed.includes(rule), `${rule} would match packages/x/package.json too`)
  for (const rule of editWrite('/README.md')) assert.ok(disallowed.includes(rule), rule)
  assert.ok(disallowed.includes('Read(/.env)'))
  const rules = [...allowed, ...disallowed]
  const bare = rules.filter((r) => !r.slice(r.indexOf('(') + 1).includes('/') && /^(Edit|Write|Read)\(/.test(r))
  assert.deepEqual(bare, [], 'no path rule is left without a slash')
})

test('glob characters in a listed path are escaped, so the rule names that path and no other', () => {
  const locus = ['app/[slug]/page.tsx', 'app/(auth)/', 'lib/a*b/c?.ts']
  const baseFiles = ['app/[slug]/page.tsx', 'app/[slug]/old.test.ts']
  const { allowed, disallowed } = permissionsFor({ locus, baseFiles, held: ['app/[id]/x.ts', 'lib/(held)/'], denyRead: ['data/[a]/k.json'] })
  for (const rule of editWrite('app/\\[slug\\]/old.test.ts')) assert.ok(disallowed.includes(rule), `an existing test: ${rule}`)
  for (const rule of editWrite('lib/\\(held\\)/**')) assert.ok(disallowed.includes(rule), `a held folder: ${rule}`)
  for (const rule of editWrite('app/\\[slug\\]/page.tsx')) assert.ok(allowed.includes(rule), rule)
  for (const rule of editWrite('app/\\(auth\\)/**')) assert.ok(allowed.includes(rule), rule)
  for (const rule of editWrite('lib/a\\*b/c\\?.ts')) assert.ok(allowed.includes(rule), rule)
  for (const rule of editWrite('app/\\[id\\]/x.ts')) assert.ok(disallowed.includes(rule), rule)
  assert.ok(disallowed.includes('Read(data/\\[a\\]/k.json)'))
  for (const rule of allowed) assert.ok(!rule.includes('[slug]') && !rule.includes('(auth)') && !rule.includes('a*b'), `unescaped: ${rule}`)
  const beside = permissionsFor({ locus: ['app/[slug]/page.tsx'] }).allowed
  for (const glob of TEST_GLOBS) {
    for (const rule of editWrite('app/\\[slug\\]/' + glob)) assert.ok(beside.includes(rule), `the folder's test globs: ${rule}`)
  }
})

test('glob characters are escaped in a barred producer\'s test denials too', () => {
  const { disallowed } = permissionsFor({ locus: ['app/[slug]/'], tests: false })
  for (const glob of TEST_GLOBS) {
    for (const rule of editWrite('app/\\[slug\\]/**/' + glob)) assert.ok(disallowed.includes(rule), rule)
  }
  for (const folder of TEST_FOLDERS) {
    for (const rule of editWrite('app/\\[slug\\]/**/' + folder + '/**')) assert.ok(disallowed.includes(rule), rule)
  }
})

test('a directory entry becomes a subtree rule', () => {
  const { allowed } = permissionsFor({ locus: ['src/b/', 'docs/guide/'] })
  for (const dir of ['src/b', 'docs/guide']) {
    for (const rule of editWrite(`${dir}/**`)) assert.ok(allowed.includes(rule), rule)
  }
})

test('a listed file\'s folder admits test names once', () => {
  const locus = ['src/a/X.ts', 'src/a/Y.ts', 'pkg/bar.go']
  const { allowed } = permissionsFor({ locus, baseFiles: ['src/a/X.ts', 'pkg/bar.go'] })
  for (const folder of new Set(locus.map(dirOf))) {
    for (const glob of TEST_GLOBS) {
      for (const rule of editWrite(`${folder}/${glob}`)) assert.equal(count(allowed, rule), 1, rule)
    }
  }
})

test('no test globs at the root or for a barred producer', () => {
  const globRule = (rule) => TEST_GLOBS.some((g) => rule.endsWith(`${g})`))
  const root = permissionsFor({ locus: ['index.mjs', 'README.md'] })
  assert.deepEqual(root.allowed.filter(globRule), [])
  const barred = permissionsFor({ locus: ['src/a/X.ts'], baseFiles: ['src/a/X.ts'], tests: false })
  assert.deepEqual(barred.allowed.filter(globRule), [])
  for (const rule of editWrite('src/a/X.ts')) assert.ok(barred.allowed.includes(rule), rule)
})

test('test dirs admit new test names in each folder and deny the existing unlisted tests there', () => {
  const baseFiles = ['test/a.test.ts', 'src/b/Old.test.ts', 'src/b/Y.ts']
  const { allowed, disallowed } = permissionsFor({ locus: ['test/a.test.ts'], testDirs: ['src/b/', 'pkg'], baseFiles })
  for (const folder of ['test', 'src/b', 'pkg']) {
    for (const glob of TEST_GLOBS) {
      for (const rule of editWrite(`${folder}/${glob}`)) assert.equal(count(allowed, rule), 1, rule)
    }
  }
  for (const rule of editWrite('src/b/Old.test.ts')) assert.ok(disallowed.includes(rule), rule)
  for (const rule of editWrite('src/b/Y.ts')) assert.ok(!allowed.includes(rule), `a source in a test dir stays unwritable: ${rule}`)
})

test('test dirs give no test glob at the root or to a producer barred from tests', () => {
  const globRule = (rule) => TEST_GLOBS.some((g) => rule.endsWith(`${g})`))
  assert.deepEqual(permissionsFor({ locus: ['index.mjs'], testDirs: [''] }).allowed.filter(globRule), [])
  assert.deepEqual(permissionsFor({ locus: ['src/a/X.ts'], testDirs: ['src/b/'], tests: false }).allowed.filter(globRule), [])
})

test('a barred producer may not edit a listed test', () => {
  const locus = ['src/a/X.ts', 'src/a/X.test.ts', 'test/locus.test.mjs']
  const { allowed, disallowed } = permissionsFor({ locus, baseFiles: ['src/a/X.ts'], tests: false })
  for (const file of ['src/a/X.test.ts', 'test/locus.test.mjs']) {
    for (const rule of editWrite(file)) {
      assert.ok(disallowed.includes(rule), `disallowed ${rule}`)
      assert.ok(!allowed.includes(rule), `not allowed ${rule}`)
    }
  }
  for (const rule of editWrite('src/a/X.ts')) assert.ok(allowed.includes(rule), rule)
})

test('a barred producer may not edit tests under a directory entry', () => {
  const { allowed, disallowed } = permissionsFor({ locus: ['src/b/'], tests: false })
  for (const rule of editWrite('src/b/**')) assert.ok(allowed.includes(rule), rule)
  for (const glob of TEST_GLOBS) {
    for (const rule of editWrite(`src/b/**/${glob}`)) assert.ok(disallowed.includes(rule), rule)
  }
  for (const folder of TEST_FOLDERS) {
    for (const rule of editWrite(`src/b/**/${folder}/**`)) assert.ok(disallowed.includes(rule), rule)
  }
})

test('a barred producer gets no test folder', () => {
  for (const dir of ['test/fixtures', 'pkg/__tests__/data']) {
    const { allowed, disallowed } = permissionsFor({ locus: [`${dir}/`], tests: false })
    for (const rule of editWrite(`${dir}/**`)) {
      assert.ok(disallowed.includes(rule), `disallowed ${rule}`)
      assert.ok(!allowed.includes(rule), `not allowed ${rule}`)
    }
  }
  const open = permissionsFor({ locus: ['test/fixtures/'] })
  for (const rule of editWrite('test/fixtures/**')) {
    assert.ok(open.allowed.includes(rule), `a producer allowed tests keeps ${rule}`)
    assert.ok(!open.disallowed.includes(rule), rule)
  }
})

test('existing unlisted tests are denied by name', () => {
  const locus = ['src/a/X.ts', 'src/a/Kept.test.ts']
  const baseFiles = ['src/a/X.ts', 'src/a/X.test.ts', 'src/a/foo_test.ts', 'src/a/Kept.test.ts', 'src/a/notes.md']
  const { disallowed } = permissionsFor({ locus, baseFiles })
  for (const file of ['src/a/X.test.ts', 'src/a/foo_test.ts']) {
    for (const rule of editWrite(file)) assert.ok(disallowed.includes(rule), rule)
  }
  for (const rule of [...editWrite('src/a/Kept.test.ts'), ...editWrite('src/a/notes.md')]) {
    assert.ok(!disallowed.includes(rule), `a listed test or a non-test is not denied: ${rule}`)
  }
})

test('held paths are denied', () => {
  const held = ['src/a/X.test.ts', 'src/c/Z.ts']
  const { disallowed } = permissionsFor({ locus: ['src/a/X.ts', 'src/c/'], baseFiles: ['src/a/X.ts'], held })
  for (const path of held) {
    for (const rule of editWrite(path)) assert.ok(disallowed.includes(rule), rule)
  }
})

test('paths a call must not read are denied', () => {
  const denyRead = ['secrets/.env', 'docs/answer.md']
  const { allowed, disallowed } = permissionsFor({ locus: ['src/a/X.ts'], denyRead })
  for (const path of denyRead) {
    assert.ok(disallowed.includes(`Read(${path})`), path)
    assert.ok(!allowed.includes(`Read(${path})`), path)
  }
})

test('commands become bash rules', () => {
  const commands = ['npm test', 'node']
  const some = permissionsFor({ locus: ['src/a/X.ts'], commands })
  for (const command of commands) assert.ok(some.allowed.includes(`Bash(${command}:*)`), command)
  assert.ok(!some.allowed.includes('Bash'), 'a listed command is no licence for every command')
  const all = permissionsFor({ locus: ['src/a/X.ts'], commands: ['*'] })
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
  const { disallowed } = permissionsFor({ locus: ['src/a/X.ts'], commands: ['git diff', 'git log', 'git show', 'git commit', 'git status'] })
  const denies = (command) => disallowed.some((r) => r.startsWith('Bash(') && bashRuleMatches(r, command))
  for (const command of reaching) assert.ok(denies(command), `${command} is not denied`)
  for (const command of harmless) assert.ok(!denies(command), `${command} is denied`)
})

test('a read-only git role gets the git denials too', () => {
  const { disallowed } = permissionsFor({ locus: [], commands: ['git log', 'git show', 'git diff'] })
  for (const rule of GIT_DENY) assert.ok(disallowed.includes(rule), rule)
})

test('git options that reach past a worktree are denied with any shell', () => {
  assert.ok(GIT_DENY.length > 0)
  for (const commands of [['npm test'], ['*']]) {
    const { disallowed } = permissionsFor({ locus: ['src/a/X.ts'], commands })
    for (const rule of GIT_DENY) assert.ok(disallowed.includes(rule), `${commands}: ${rule}`)
  }
  const none = permissionsFor({ locus: ['src/a/X.ts'] })
  assert.deepEqual(none.allowed.filter((r) => r === 'Bash' || r.startsWith('Bash(')), [])
  for (const rule of GIT_DENY) assert.ok(!none.disallowed.includes(rule), rule)
})

test('no rule is listed twice', () => {
  const inputs = [
    { locus: ['src/a/X.ts', 'src/a/Y.ts', 'src/a/X.ts', 'src/b/', 'src/b/'],
      baseFiles: ['src/a/X.ts', 'src/a/X.test.ts', 'src/a/X.test.ts'],
      held: ['src/c/Z.ts', 'src/c/Z.ts', 'src/a/X.test.ts'],
      commands: ['npm test', 'npm test', 'node'], denyRead: ['a.md', 'a.md'] },
    { locus: ['src/a/X.ts', 'src/a/X.test.ts', 'src/b/', 'test/fixtures/'], baseFiles: ['src/a/X.test.ts'],
      held: ['src/a/X.test.ts'], tests: false, commands: ['*', 'node'] },
  ]
  for (const input of inputs) {
    const { allowed, disallowed } = permissionsFor(input)
    assert.deepEqual(allowed, [...new Set(allowed)])
    assert.deepEqual(disallowed, [...new Set(disallowed)])
  }
})

test('a locus written with backslashes reads as forward slashes', () => {
  const forward = ['src/a/X.ts', 'src/b/']
  const back = ['src\\a\\X.ts', 'src\\b\\']
  const baseFiles = ['src/a/X.ts', 'src/a/Old.test.ts']
  const paths = ['src/a/X.ts', 'src/a/X.test.ts', 'src/a/Old.test.ts', 'src/a/X.helpers.ts', 'src/b/deep/y.ts',
    'src/bx/y.ts', 'lib/other.mjs']
  for (const tests of [true, false]) {
    for (const path of paths) {
      assert.equal(admits({ locus: back, path, baseFiles, tests }), admits({ locus: forward, path, baseFiles, tests }),
        `${path} tests=${tests}`)
    }
    const f = permissionsFor({ locus: forward, baseFiles, tests, commands: ['node'] })
    const b = permissionsFor({ locus: back, baseFiles, tests, commands: ['node'] })
    assert.deepEqual(sorted(b.allowed), sorted(f.allowed))
    assert.deepEqual(sorted(b.disallowed), sorted(f.disallowed))
  }
  assert.equal(admits({ locus: back, path: 'src/a/X.ts', baseFiles }), true, 'the forward form is not vacuous')
})

// ---------------------------------------------------------------- one test-file table

/** A permission pattern as the host reads it, gitignore-style: `**` spans folders, `*` stays in one, `[..]` is one of a set. */
const globMatches = (pattern, path) => {
  const body = pattern.replace(/^\//, '').replace(/\*\*\/|\*\*|\*|\[[^\]]*\]|\\.|./g, (t) =>
    t === '**/' ? '(?:.*/)?' : t === '**' ? '.*' : t === '*' ? '[^/]*' : t.startsWith('[') ? t
      : t.slice(-1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp('^' + body + '$').test(path)
}
/** Whether an Edit rule among `rules` reaches `path`. */
const ruled = (rules, path) =>
  rules.filter((r) => r.startsWith('Edit(')).some((r) => globMatches(r.slice('Edit('.length, -1), path))

/** A name a glob matches: each `*` as `fill`, each letter set as its first member, or its last when `last`. */
const nameOf = (glob, last = false, fill = '0') =>
  glob.replace(/\*/g, fill).replace(/\[([^\]]*)\]/g, (_, set) => (last ? set.slice(-1) : set[0]))
/** The names an entry matches: one per spelling its letter sets allow, each `*` as a digit or as dotted, dashed text. */
const namesOf = ({ glob }) =>
  [...new Set([false, true].flatMap((last) => ['0', 'a-1.min'].map((fill) => nameOf(glob, last, fill))))]
/** Names one step from an entry's: the first letter dropped, and lower case for a glob with no letter sets. */
const nearMisses = ({ glob }) => [false, true].map((last) => nameOf(glob, last)).flatMap((name) =>
  [name.replace(/[a-z]/i, ''), ...(glob.includes('[') ? [] : [name.toLowerCase()])])
const FILE_ENTRIES = TEST_PATTERNS.filter((t) => !t.folder)

test('each file entry of the test-file table is a test path a listed file\'s folder may write', () => {
  assert.ok(FILE_ENTRIES.length > 0)
  const { allowed } = permissionsFor({ locus: ['src/a/X.ts'], baseFiles: ['src/a/X.ts'] })
  for (const entry of FILE_ENTRIES) {
    for (const rule of editWrite('src/a/' + entry.glob)) assert.ok(allowed.includes(rule), rule)
    for (const name of namesOf(entry)) {
      const path = 'src/a/' + name
      assert.ok(globMatches(entry.glob, name), `${entry.glob} names ${name}`)
      assert.equal(isTestPath(path), true, `${path} is a test path`)
      assert.ok(ruled(allowed, path), `${path} gets a test glob`)
    }
  }
})

test('each entry of the test-file table is a test path a barred producer may not write under a directory entry', () => {
  assert.ok(TEST_FOLDERS.length > 0)
  const { disallowed } = permissionsFor({ locus: ['src/b/'], tests: false })
  for (const entry of TEST_PATTERNS) {
    for (const name of namesOf(entry)) {
      const path = 'src/b/deep/' + name + (entry.folder ? '/0.js' : '')
      assert.equal(isTestPath(path), true, `${path} is a test path`)
      assert.ok(ruled(disallowed, path), `${path} is denied`)
    }
  }
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

test('a name no entry of the test-file table matches is no test path and gets no test glob', () => {
  const beside = permissionsFor({ locus: ['src/a/X.ts'], baseFiles: ['src/a/X.ts'] }).allowed
  const barred = permissionsFor({ locus: ['src/b/'], tests: false }).disallowed
  const misses = TEST_PATTERNS.flatMap((entry) => nearMisses(entry).map((name) => ({ entry, name })))
  assert.ok(misses.length > TEST_PATTERNS.length)
  for (const { entry, name } of misses) {
    assert.ok(!TEST_PATTERNS.some((t) => globMatches(t.glob, name)), `${name} is matched by no entry`)
    const file = 'src/a/' + name
    const under = 'src/b/deep/' + name + (entry.folder ? '/0.js' : '')
    assert.equal(isTestPath(file), false, file)
    assert.equal(isTestPath(under), false, under)
    assert.ok(!ruled(beside, file), `${file} gets no test glob`)
    assert.ok(!ruled(barred, under), `${under} is not denied`)
  }
})

test('a file entry matches the last segment of a path, not a folder it sits under', () => {
  for (const entry of FILE_ENTRIES) {
    for (const name of namesOf(entry)) {
      assert.equal(isTestPath('src/a/' + name), true, name)
      assert.equal(isTestPath('src/a/' + name + '/0.js'), false, `${name} as a folder`)
    }
  }
})
