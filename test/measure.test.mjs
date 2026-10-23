// test/measure.test.mjs — lib/measure.mjs: a check as an awaited child, reused by key, the user's
// checkout watched.
//
// What is pinned here:
//
//   measureKey   one key per measurement input — the head, the worktree's status, the base, the
//                mode, the rigor, the role, the producer, the commands, the mutations, the tests,
//                the checks, the approved files, the expected files, the fences — and none
//                for where or for whom the measurement is taken
//   measure      the payload comes from a `lib/verify.mjs` child over a real linked worktree; the
//                line it journals carries the key; the same key is not measured again, unless what
//                it journalled was broken; a broken child is an `environment_broken` payload, and
//                its watch failing is one too; the event loop runs while the child
//                does; a moved user ref is `moved`, a framework ref is not
//
// Design: docs/DESIGN.md#verification.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { measure, measureKey } from '../lib/measure.mjs'
import { append, readLog } from '../lib/ledger.mjs'
import { snapshotCheckout } from '../lib/watch.mjs'
import { BRANCH, EFFORT, EXECUTION, NODE, git, options, order } from './harness/verify-fixture.mjs'

const PASS = "node -e 'process.exit(0)'"
const posix = (p) => String(p).split('\\').join('/')

/** The child's environment: never the test runner's mark, or a grandchild `node --test` runs nothing. */
const childEnv = () => {
  const { NODE_TEST_CONTEXT: _, ...env } = process.env
  return env
}

/** `child_process.spawn`, counted. */
function counted() {
  const calls = []
  return { calls, spawn: (cmd, args, opts) => { calls.push(args); return spawn(cmd, args, { ...opts, env: childEnv() }) } }
}

/** A spawn that starts `script` in place of whatever it is asked to start. */
const instead = (script) => (cmd, args, opts) => spawn(process.execPath, ['-e', script], { ...opts, env: childEnv() })

/** A linked worktree carrying the widget order, the execution measuring in it, and verify's options for a `verify` leaf. */
function rig(t, checks = [PASS]) {
  const { dir, worktree, base, head } = order(t)
  const xc = { repo: dir, effort: EFFORT, execution: EXECUTION }
  const opts = { ...options({ worktree, base, head }), rigor: 'verify', node: NODE, branch: BRANCH, checks }
  return { dir, worktree, head, xc, opts }
}

const journal = (dir) => readLog(dir, EFFORT, 'journal:' + EXECUTION).entries.filter((e) => e.kind === 'verify-observed')
const markers = (dir) => readLog(dir, EFFORT, 'journal:' + EXECUTION).entries.filter((e) => e.kind === 'measure-done')
const keyOf = (opts, worktree) => measureKey(opts, { status: snapshotCheckout(worktree).status })

// ------------------------------------------------------------------ measureKey

const KEYED = {
  base: 'b0', head: 'h0', mode: 'order', rigor: 'tdd', role: 'green', producer: 'implementer',
  build: 'node build.mjs', typecheck: '', suite: 'node --test', suiteFast: '', testOne: 'node --test {file}', scope: 'full',
  buildAbsent: false, typecheckAbsent: true, suiteAbsent: false, suiteFastAbsent: false,
  mutations: [{ file: 'src/a.mjs', find: 'a', replace: 'b' }], tests: ['test/a.test.mjs'], checks: ['node lint.mjs'],
  approved: [{ file: 'test/a.test.mjs', sha: 's0' }], expects: ['src/a.mjs'], fences: {},
  worktree: '/w', node: 'n', branch: 'agentics/e--n', repo: '/r', effort: 'e', execution: '20260925-120000', key: '',
}
const STATUS = { status: { 'notes.txt': 'blob0' } }

test('measureKey is the same for the same options and status', () => {
  assert.equal(measureKey({ ...KEYED }, { status: { ...STATUS.status } }), measureKey(KEYED, STATUS))
  assert.match(measureKey(KEYED, STATUS), /^[0-9a-f]{8}$/)
})

const CHANGES = [
  ['the head', { head: 'h1' }],
  ['the base', { base: 'b1' }],
  ['the mode', { mode: 'integration' }],
  ['the rigor', { rigor: 'trivial' }],
  ['the role', { role: 'red' }],
  ['the producer', { producer: 'test-author' }],
  ['the mutations', { mutations: [] }],
  ['the tests', { tests: ['test/b.test.mjs'] }],
  ['the checks', { checks: ['node other.mjs'] }],
  ['the approved files', { approved: [{ file: 'test/a.test.mjs', sha: 's1' }] }],
  ['the expected files', { expects: ['src/a.mjs', 'src/b.mjs'] }],
  ['the fences', { fences: { abc1234: ['src/a.mjs'] } }],
]
for (const [what, change] of CHANGES) {
  test('measureKey changes with ' + what, () => {
    assert.notEqual(measureKey({ ...KEYED, ...change }, STATUS), measureKey(KEYED, STATUS))
  })
}

test('measureKey changes with the worktree status', () => {
  assert.notEqual(measureKey(KEYED, { status: { 'notes.txt': 'blob1' } }), measureKey(KEYED, STATUS))
  assert.notEqual(measureKey(KEYED, { status: {} }), measureKey(KEYED, STATUS))
})

test('measureKey changes with each command: build, typecheck, suite, suiteFast, testOne, scope and the absent flags', () => {
  const commands = [
    { build: 'node other-build.mjs' }, { typecheck: 'tsc' }, { suite: 'npm test' }, { suiteFast: 'npm run fast' },
    { testOne: 'npx vitest {file}' }, { scope: 'fast' }, { buildAbsent: true }, { typecheckAbsent: false },
    { suiteAbsent: true }, { suiteFastAbsent: true },
  ]
  for (const change of commands) {
    assert.notEqual(measureKey({ ...KEYED, ...change }, STATUS), measureKey(KEYED, STATUS), JSON.stringify(change))
  }
})

test('measureKey ignores where and for whom it measures', () => {
  const elsewhere = { worktree: '/other', node: 'm', branch: 'agentics/e--m', repo: '/s', effort: 'f', execution: '20260926-120000', key: 'k' }
  assert.equal(measureKey({ ...KEYED, ...elsewhere }, STATUS), measureKey(KEYED, STATUS))
})

// ------------------------------------------------------------------ measure

test('the payload comes from the child', { timeout: 60_000 }, async (t) => {
  const { xc, opts } = rig(t)
  const counter = counted()
  const out = await measure(xc, opts, { spawn: counter.spawn })
  assert.equal(counter.calls.length, 1)
  assert.match(counter.calls[0].join(' '), /verify\.mjs --options -$/)
  assert.equal(out.reused, false)
  assert.equal(out.payload.stop_reason, 'completed', JSON.stringify(out.payload.error))
  assert.deepEqual(out.payload.checks.map((c) => [c.command, c.status]), [[PASS, 'passed']])
  assert.deepEqual(out.payload.journal, { written: true, error: '' })
})

test('the verify-observed it journals carries the key', { timeout: 60_000 }, async (t) => {
  const { dir, worktree, xc, opts } = rig(t)
  const expected = keyOf(opts, worktree)
  await measure(xc, opts, { spawn: counted().spawn })
  const lines = journal(dir)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].key, expected)
  assert.equal(lines[0].node, NODE)
  assert.deepEqual(lines[0].approved_failing, [])
})

test('a measurement journalled at the same key is not taken again', { timeout: 60_000 }, async (t) => {
  const { dir, worktree, xc, opts } = rig(t)
  const counter = counted()
  const first = await measure(xc, opts, { spawn: counter.spawn })
  const again = await measure(xc, opts, { spawn: counter.spawn })
  assert.equal(counter.calls.length, 1, 'nothing spawned the second time')
  assert.equal(again.reused, true)
  assert.equal(again.moved, false)
  assert.equal(again.payload.key, keyOf(opts, worktree))
  assert.equal(again.payload.stop_reason, first.payload.stop_reason)
  assert.deepEqual(again.payload.checks, first.payload.checks)
  assert.equal(journal(dir).length, 1, 'and nothing journalled')
  assert.equal(markers(dir).length, 1, 'and no second marker')
})

test('a measurement whose after-watch threw is measured again, not reused', { timeout: 60_000 }, async (t) => {
  const { dir, worktree, xc, opts } = rig(t)
  const counter = counted()
  const failing = { before: () => ({}), after: () => { throw new Error('unreadable') } }
  const first = await measure(xc, opts, { spawn: counter.spawn, watch: failing })
  assert.equal(first.payload.error.kind, 'watch_failed')
  assert.equal(journal(dir).length, 1, 'the child journalled before the watch failed')
  assert.equal(markers(dir).length, 0, 'and the watch never vouched for it')
  const again = await measure(xc, opts, { spawn: counter.spawn })
  assert.equal(counter.calls.length, 2, 'the unmarked line is not a measurement taken')
  assert.equal(again.reused, false)
  assert.equal(again.payload.stop_reason, 'completed', JSON.stringify(again.payload.error))
  assert.equal(markers(dir).length, 1)
  assert.equal(markers(dir)[0].key, keyOf(opts, worktree))
})

test('a marker of another key does not vouch for an unmarked line', { timeout: 60_000 }, async (t) => {
  const { dir, worktree, xc, opts } = rig(t)
  const counter = counted()
  const failing = { before: () => ({}), after: () => { throw new Error('unreadable') } }
  await measure(xc, opts, { spawn: counter.spawn, watch: failing })
  writeFileSync(join(worktree, 'notes.txt'), 'one\n')
  await measure(xc, opts, { spawn: counter.spawn })
  rmSync(join(worktree, 'notes.txt'))
  const back = await measure(xc, opts, { spawn: counter.spawn })
  assert.equal(counter.calls.length, 3, 'the first key was never marked, whatever marked the second')
  assert.equal(back.reused, false)
  assert.equal(markers(dir).length, 2)
})

test('a marker that precedes a later unmarked line at the same key does not vouch for it', { timeout: 60_000 }, async (t) => {
  const { dir, worktree, xc, opts } = rig(t)
  const counter = counted()
  await measure(xc, opts, { spawn: counter.spawn })
  const key = keyOf(opts, worktree)
  const written = append(dir, EFFORT, 'journal:' + EXECUTION, { kind: 'verify-observed', node: NODE, key, stop_reason: 'completed', checks: [] })
  assert.equal(written.ok, true, written.error)
  const again = await measure(xc, opts, { spawn: counter.spawn })
  assert.equal(counter.calls.length, 2, 'the newer line has no marker after it')
  assert.equal(again.reused, false)
})

test('a measurement that saw a moved ref is reused with moved: true', { timeout: 60_000 }, async (t) => {
  const { dir, head, xc, opts } = rig(t)
  git(dir, 'branch', 'side', 'main')
  const moving = { ...opts, checks: ["git -C '" + posix(dir) + "' update-ref refs/heads/side " + head] }
  const counter = counted()
  const first = await measure(xc, moving, { spawn: counter.spawn })
  assert.equal(first.moved, true)
  const again = await measure(xc, moving, { spawn: counter.spawn })
  assert.equal(counter.calls.length, 1, 'nothing spawned the second time')
  assert.equal(again.reused, true)
  assert.equal(again.moved, true, 'the marker carries what the watch saw')
  assert.equal(markers(dir).length, 1)
})

test('a broken measurement journalled at the same key is taken again', { timeout: 60_000 }, async (t) => {
  const { dir, worktree, xc, opts } = rig(t)
  const written = append(dir, EFFORT, 'journal:' + EXECUTION, {
    kind: 'verify-observed', node: NODE, key: keyOf(opts, worktree), stop_reason: 'environment_broken', checks: [],
  })
  assert.equal(written.ok, true, written.error)
  const counter = counted()
  const out = await measure(xc, opts, { spawn: counter.spawn })
  assert.equal(counter.calls.length, 1)
  assert.equal(out.reused, false)
  assert.equal(out.payload.stop_reason, 'completed', JSON.stringify(out.payload.error))
})

test('a changed worktree status gives a new key and a new measurement', { timeout: 60_000 }, async (t) => {
  const { dir, worktree, xc, opts } = rig(t)
  const counter = counted()
  await measure(xc, opts, { spawn: counter.spawn })
  writeFileSync(join(worktree, 'notes.txt'), 'one\n')
  const second = await measure(xc, opts, { spawn: counter.spawn })
  assert.equal(counter.calls.length, 2)
  assert.equal(second.reused, false)
  const keys = journal(dir).map((e) => e.key)
  assert.equal(keys.length, 2)
  assert.notEqual(keys[1], keys[0])
  assert.equal(keys[1], keyOf(opts, worktree))
})

test('an edit to an already dirty file gives a new key and a new measurement', { timeout: 60_000 }, async (t) => {
  const { dir, worktree, xc, opts } = rig(t)
  const counter = counted()
  writeFileSync(join(worktree, 'notes.txt'), 'one\n')
  await measure(xc, opts, { spawn: counter.spawn })
  writeFileSync(join(worktree, 'notes.txt'), 'two\n')
  const second = await measure(xc, opts, { spawn: counter.spawn })
  assert.equal(counter.calls.length, 2, 'the same porcelain status, a different content')
  assert.equal(second.reused, false)
  assert.equal(new Set(journal(dir).map((e) => e.key)).size, 2)
})

test('a child that exits non-zero gives an environment_broken payload naming why', { timeout: 60_000 }, async (t) => {
  const { xc, opts } = rig(t)
  const out = await measure(xc, opts, { spawn: instead("process.stderr.write('boom'); process.exit(3)") })
  assert.equal(out.reused, false)
  assert.equal(out.payload.stop_reason, 'environment_broken')
  assert.equal(out.payload.error.kind, 'measure_failed')
  assert.match(out.payload.error.message, /exited 3/)
  assert.match(out.payload.error.message, /boom/)
})

test('a child that prints no payload gives an environment_broken payload', { timeout: 60_000 }, async (t) => {
  const { xc, opts } = rig(t)
  const out = await measure(xc, opts, { spawn: instead("process.stdout.write('not json')") })
  assert.equal(out.payload.stop_reason, 'environment_broken')
  assert.equal(out.payload.error.kind, 'measure_failed')
  assert.match(out.payload.error.message, /printed no payload/)
})

test('a broken child journals nothing and the next call measures', { timeout: 60_000 }, async (t) => {
  const { dir, xc, opts } = rig(t)
  await measure(xc, opts, { spawn: instead('process.exit(1)') })
  assert.equal(journal(dir).length, 0)
  const counter = counted()
  const out = await measure(xc, opts, { spawn: counter.spawn })
  assert.equal(counter.calls.length, 1)
  assert.equal(out.reused, false)
  assert.equal(out.payload.stop_reason, 'completed', JSON.stringify(out.payload.error))
  assert.equal(journal(dir).length, 1)
})

test('the event loop runs while a check runs', { timeout: 60_000 }, async (t) => {
  // The check passes only when the file a timer of this process writes appears, and gives up
  // after 20 s. A measurement that held the event loop would keep the timer from firing.
  const scratch = mkdtempSync(join(tmpdir(), 'agentics-measure-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  const script = posix(join(scratch, 'wait.mjs'))
  const go = posix(join(scratch, 'go'))
  writeFileSync(script, [
    "import { existsSync } from 'node:fs'",
    'const until = Date.now() + 20000',
    'const poll = setInterval(() => {',
    '  if (existsSync(process.argv[2])) { clearInterval(poll); process.exit(0) }',
    '  if (Date.now() > until) { clearInterval(poll); process.exit(1) }',
    '}, 20)',
    '',
  ].join('\n'))
  const { xc, opts } = rig(t, ["node '" + script + "' '" + go + "'"])
  let fired = false
  const timer = setTimeout(() => { fired = true; writeFileSync(go, '') }, 200)
  t.after(() => clearTimeout(timer))
  const out = await measure(xc, opts, { spawn: counted().spawn })
  assert.equal(fired, true)
  assert.equal(out.payload.checks[0].status, 'passed', 'the check saw the file the timer wrote')
})

test('a ref moved during a check is reported', { timeout: 60_000 }, async (t) => {
  const { dir, head, xc, opts } = rig(t)
  git(dir, 'branch', 'side', 'main')
  const out = await measure(xc, { ...opts, checks: ["git -C '" + posix(dir) + "' update-ref refs/heads/side " + head] }, { spawn: counted().spawn })
  assert.equal(out.payload.checks[0].status, 'passed', 'the check moved the branch')
  assert.equal(out.moved, true)
})

test('a ref untouched during a check is not reported', { timeout: 60_000 }, async (t) => {
  const { dir, xc, opts } = rig(t)
  git(dir, 'branch', 'side', 'main')
  const out = await measure(xc, opts, { spawn: counted().spawn })
  assert.equal(out.payload.stop_reason, 'completed', JSON.stringify(out.payload.error))
  assert.equal(out.moved, false)
})

test('a framework branch moved during a check is not reported', { timeout: 60_000 }, async (t) => {
  const { dir, head, xc, opts } = rig(t)
  const out = await measure(xc, { ...opts, checks: ["git -C '" + posix(dir) + "' update-ref refs/heads/agentics/widget--other " + head] }, { spawn: counted().spawn })
  assert.equal(out.payload.checks[0].status, 'passed', 'the check moved the branch')
  assert.equal(out.moved, false)
})

test('a worktree that cannot be read gives environment_broken and spawns nothing', { timeout: 60_000 }, async (t) => {
  const { dir, xc, opts } = rig(t)
  const counter = counted()
  const out = await measure(xc, { ...opts, worktree: posix(join(dir, 'no-such-worktree')) }, { spawn: counter.spawn })
  assert.equal(counter.calls.length, 0)
  assert.equal(out.payload.stop_reason, 'environment_broken')
  assert.equal(out.payload.error.kind, 'no_worktree')
})

test('a watch that cannot read the checkout before the check spawns nothing', { timeout: 60_000 }, async (t) => {
  const { xc, opts } = rig(t)
  const counter = counted()
  const watch = { before: () => { throw new Error('unreadable') }, after: () => ({ moved: [] }) }
  const out = await measure(xc, opts, { spawn: counter.spawn, watch })
  assert.equal(counter.calls.length, 0)
  assert.equal(out.payload.stop_reason, 'environment_broken')
  assert.equal(out.payload.error.kind, 'watch_failed')
  assert.match(out.payload.error.message, /unreadable/)
})

