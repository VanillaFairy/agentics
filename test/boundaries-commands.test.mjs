// test/boundaries-commands.test.mjs — pins preflight writing the commands the session named, and
// the ones it marked absent, as `command` gotchas from the session: each one the envelope names,
// never over a command gotcha `commandsOf` already reads, once per execution, and seen afterwards
// by the leaf brief, by a role's commands and by a later execution's measurement.
//
// Design: docs/DESIGN.md#gotchas and docs/DESIGN.md#boundaries.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { preflight, writeSessionCommands } from '../lib/boundaries/execution.mjs'
import { mergeBatch } from '../lib/boundaries/merge.mjs'
import { executionContext } from '../lib/boundaries/records.mjs'
import { leafBrief } from '../lib/brief.mjs'
import { commandsOf, deleteGotcha, knowledgeDir, listGotchas, readKnowledge, writeGotcha } from '../lib/gotchas.mjs'
import { ensureIntegration, ensureLeaf } from '../lib/integration.mjs'
import { executionLog } from '../lib/ledger.mjs'
import { acquireAsync } from '../lib/locks.mjs'
import { loadRole, roleCommands } from '../lib/roles.mjs'
import { dispatchKey, executionDir } from '../lib/store.mjs'
import { readTree } from '../lib/tree.mjs'
import { commitIn, git, leaf, repo, root, STAMP } from './harness/boundary-fixture.mjs'
import { seedTree } from './harness/seed-tree.mjs'

const E = 'e1'
const OTHER = '20260925-130000'
const NAMES = ['build', 'typecheck', 'lint', 'suite', 'suite_fast', 'test_one']
const ALL = {
  build: 'node build.mjs', typecheck: 'node typecheck.mjs', lint: 'node lint.mjs', suite: 'node --test',
  suite_fast: 'node --test test/unit', test_one: 'node --test {file}',
}

/** A repository holding a root and leaf `a` as the effort's tree, removed after the test. */
function world(t) {
  const r = repo()
  t.after(() => rmSync(r, { recursive: true, force: true }))
  const seeded = seedTree(r, E, [root(), leaf('a', { expects: ['src/a.mjs'] })])
  assert.equal(seeded.ok, true, JSON.stringify(seeded))
  return r
}

/** A new run of the execution `stamp`: a fresh port and the `run` record lib/run.mjs writes first. */
function relaunch(r, stamp = STAMP) {
  const xc = executionContext({ repo: r, effort: E, execution: stamp, log: executionLog(r, E, stamp) })
  xc.log.append('run', { program: 'execute', scope: { effort: E }, pid: 1 })
  return xc
}

/** The commands file the session writes with its Write tool. */
function commandsFile(t, value) {
  const dir = mkdtempSync(join(tmpdir(), 'agentics-commands-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'commands.json')
  writeFileSync(path, JSON.stringify(value))
  return path
}

/** A command gotcha as an agent returns it. */
const commandGotcha = (name, value, absent = false) => ({
  kind: 'command', roles: ['implementer', 'investigator'], paths: [], trigger: 'running ' + name, action: 'use it',
  evidence: { command: value || 'ls', output: 'ok' }, command: { name, value, absent },
})

const gotchaOf = (r, name) => listGotchas(r, E).find((g) => g.id === 'command-' + name)
const ids = (r) => listGotchas(r, E).map((g) => g.id)
const fileOf = (r, name) => join(knowledgeDir(r, E), 'command-' + name + '.md')
const envelopeOf = (r) => JSON.parse(readFileSync(join(executionDir(r, E, STAMP), 'execution.json'), 'utf8'))

/** Every knowledge file's text, by name. */
const snapshot = (r) => Object.fromEntries(readdirSync(knowledgeDir(r, E)).sort().map((n) => [n, readFileSync(join(knowledgeDir(r, E), n), 'utf8')]))

/** Rewrite a gotcha file with a marker in its body: a rewrite by preflight would drop it. */
const mark = (r, name) => writeFileSync(fileOf(r, name), readFileSync(fileOf(r, name), 'utf8') + '\nmarker\n')

test('each command the commands file names becomes a session command gotcha commandsOf returns', (t) => {
  const r = world(t)
  assert.equal(preflight(relaunch(r), { commands_file: commandsFile(t, ALL) }).ok, true)
  const found = commandsOf(r, E)
  const base = envelopeOf(r).base_sha
  for (const name of NAMES) {
    assert.equal(found[name], ALL[name], name)
    const g = gotchaOf(r, name)
    assert.equal(g.kind, 'command')
    assert.equal(g.source.role, 'session')
    assert.equal(g.observed_at, base)
    assert.deepEqual(g.command, { name, value: ALL[name], absent: false })
  }
})

test('a command the commands file leaves out or gives empty writes no gotcha', (t) => {
  const r = world(t)
  preflight(relaunch(r), { commands_file: commandsFile(t, { suite: '  node --test ', build: '', typecheck: '   ', absent: { suite_fast: false } }) })
  assert.deepEqual(ids(r), ['command-suite'])
  assert.equal(commandsOf(r, E).suite, 'node --test', 'the value is trimmed')
  assert.deepEqual(commandsOf(r, E).absent, { setup: false, build: false, typecheck: false, lint: false, suite: false, suite_fast: false })
})

test('each command the commands file marks absent becomes an absent session command gotcha', (t) => {
  const r = world(t)
  writeGotcha(r, E, commandGotcha('suite', 'npm test'), { source: { role: 'investigator' } })
  const before = readFileSync(fileOf(r, 'suite'), 'utf8')
  const absent = { build: true, typecheck: true, suite: true, suite_fast: true, test_one: true }
  preflight(relaunch(r), { commands_file: commandsFile(t, { build: 'node build.mjs', test_one: 'node --test {file}', absent }) })
  assert.deepEqual(ids(r).sort(), ['command-build', 'command-suite', 'command-suite_fast', 'command-test_one', 'command-typecheck'])
  for (const name of ['build', 'typecheck', 'suite_fast']) {
    const g = gotchaOf(r, name)
    assert.equal(g.source.role, 'session', name)
    assert.equal(g.observed_at, envelopeOf(r).base_sha, name)
    assert.deepEqual(g.command, { name, value: '', absent: true }, name)
  }
  assert.equal(readFileSync(fileOf(r, 'suite'), 'utf8'), before, 'the investigator\'s suite stands')
  assert.deepEqual(gotchaOf(r, 'test_one').command, { name: 'test_one', value: 'node --test {file}', absent: false }, 'test_one has no absent')
  const found = commandsOf(r, E)
  assert.deepEqual(found.absent, { setup: false, build: true, typecheck: true, lint: false, suite: false, suite_fast: true })
  assert.deepEqual([found.build, found.typecheck, found.suite, found.suite_fast], ['', '', 'npm test', ''])
})

test('an envelope with no commands writes no gotcha', (t) => {
  const r = world(t)
  assert.equal(preflight(relaunch(r), {}).ok, true)
  assert.equal(envelopeOf(r).commands, null)
  assert.deepEqual(ids(r), [])
})

test('an adopted envelope\'s commands are written when no gotcha names them', (t) => {
  const r = world(t)
  const base_sha = git(r, 'rev-parse', 'HEAD')
  mkdirSync(executionDir(r, E, STAMP), { recursive: true })
  writeFileSync(join(executionDir(r, E, STAMP), 'execution.json'), JSON.stringify({
    stamp: STAMP, root: '.', base_branch: 'main', base_sha, dial: 'normal', pace: 'balanced', commands: { suite: 'node --test' },
  }))
  assert.equal(preflight(relaunch(r), {}).ok, true)
  assert.equal(commandsOf(r, E).suite, 'node --test')
  assert.equal(gotchaOf(r, 'suite').source.role, 'session')
  assert.equal(gotchaOf(r, 'suite').observed_at, base_sha)
})

test('an investigator\'s command gotcha is kept, not overwritten', (t) => {
  const r = world(t)
  writeGotcha(r, E, commandGotcha('suite', 'npm test'), { observed_at: 'abc', source: { role: 'investigator' } })
  const before = readFileSync(fileOf(r, 'suite'), 'utf8')
  preflight(relaunch(r), { commands_file: commandsFile(t, { suite: 'node --test', test_one: 'node --test {file}' }) })
  assert.equal(readFileSync(fileOf(r, 'suite'), 'utf8'), before)
  assert.equal(commandsOf(r, E).suite, 'npm test')
  assert.equal(gotchaOf(r, 'test_one').source.role, 'session')
})

test('an investigator\'s absent command is kept', (t) => {
  const r = world(t)
  writeGotcha(r, E, commandGotcha('build', '', true), { source: { role: 'investigator' } })
  const before = readFileSync(fileOf(r, 'build'), 'utf8')
  preflight(relaunch(r), { commands_file: commandsFile(t, { build: 'node build.mjs', suite: 'node --test' }) })
  assert.equal(readFileSync(fileOf(r, 'build'), 'utf8'), before)
  const found = commandsOf(r, E)
  assert.deepEqual([found.build, found.absent.build, found.suite], ['', true, 'node --test'])
})

test('an executor\'s command gotcha gives way to the session\'s command', (t) => {
  const r = world(t)
  writeGotcha(r, E, commandGotcha('suite', 'npm test'), { source: { node: 'a', role: 'implementer' } })
  preflight(relaunch(r), { commands_file: commandsFile(t, { suite: 'node --test' }) })
  assert.equal(commandsOf(r, E).suite, 'node --test')
  assert.equal(gotchaOf(r, 'suite').source.role, 'session')
})

test('a malformed command gotcha file gives way to the session\'s command', (t) => {
  const r = world(t)
  mkdirSync(knowledgeDir(r, E), { recursive: true })
  writeFileSync(fileOf(r, 'suite'), 'not a gotcha\n')
  preflight(relaunch(r), { commands_file: commandsFile(t, { suite: 'node --test' }) })
  assert.equal(commandsOf(r, E).suite, 'node --test')
  assert.deepEqual(readKnowledge(r, E).malformed, [])
})

test('a second preflight writes nothing', (t) => {
  const r = world(t)
  preflight(relaunch(r), { commands_file: commandsFile(t, ALL) })
  for (const name of NAMES) mark(r, name)
  const before = snapshot(r)
  const again = preflight(relaunch(r), { commands_file: commandsFile(t, { ...ALL, suite: 'node --test --other' }) })
  assert.equal(again.ok, true)
  assert.deepEqual(snapshot(r), before)
  assert.equal(commandsOf(r, E).suite, ALL.suite)
})

test('a preflight run again writes back a session command whose gotcha is gone', (t) => {
  const r = world(t)
  preflight(relaunch(r), { commands_file: commandsFile(t, ALL) })
  assert.equal(deleteGotcha(r, E, 'command-test_one').deleted, true)
  mark(r, 'suite')
  const suite = readFileSync(fileOf(r, 'suite'), 'utf8')
  preflight(relaunch(r), {})
  assert.equal(commandsOf(r, E).test_one, ALL.test_one)
  assert.equal(gotchaOf(r, 'test_one').source.role, 'session')
  assert.equal(readFileSync(fileOf(r, 'suite'), 'utf8'), suite)
})

test('a refused preflight writes no gotcha', (t) => {
  const r = world(t)
  const out = preflight(relaunch(r), { base_ref: 'no-such-branch', commands_file: commandsFile(t, ALL) })
  assert.deepEqual([out.ok, out.error.kind], [false, 'no_base'])
  assert.deepEqual(ids(r), [])
})

test('a session command gotcha the store refuses is named, and the commands after it are still written', (t) => {
  const r = world(t)
  const xc = relaunch(r)
  const refusing = (repo, effort, g, opts) => (g.command.name === 'suite' ? { ok: false, error: 'the store refused it' } : writeGotcha(repo, effort, g, opts))
  const refused = writeSessionCommands(xc, { base_sha: '', commands: { ...ALL } }, { write: refusing })
  assert.deepEqual(refused, [{ name: 'suite', error: 'the store refused it' }])
  const known = commandsOf(r, E)
  for (const name of NAMES.filter((n) => n !== 'suite')) assert.equal(known[name], ALL[name], name)
  assert.ok(!known.suite, 'the refused command is not written')
})

test('a preflight whose command gotcha the store refuses is refused commands_unwritable, and a run again writes it', (t) => {
  const r = world(t)
  const refusing = (repo, effort, g, opts) => (g.command.name === 'suite' ? { ok: false, error: 'the store refused it' } : writeGotcha(repo, effort, g, opts))
  const out = preflight(relaunch(r), { commands_file: commandsFile(t, ALL), write: refusing })
  assert.deepEqual([out.ok, out.error && out.error.kind], [false, 'commands_unwritable'], JSON.stringify(out))
  assert.match(out.error.message, /suite: the store refused it/)
  assert.ok(!commandsOf(r, E).suite, 'the refused command is not written')
  assert.equal(preflight(relaunch(r), {}).ok, true, 'the adopted envelope names the commands again')
  assert.equal(commandsOf(r, E).suite, ALL.suite)
})

test('the leaf brief\'s Commands section shows the session\'s commands', (t) => {
  const r = world(t)
  preflight(relaunch(r), { commands_file: commandsFile(t, ALL) })
  const { text } = leafBrief(r, E, 'a', { worktree: join(r, 'wt'), commands: commandsOf(r, E) })
  const section = text.split('\n## Commands\n')[1].split('\n## ')[0]
  for (const name of NAMES) assert.ok(section.includes('- ' + name + ': `' + ALL[name] + '`'), name)
})

test('roleCommands gives the implementer the session\'s commands', (t) => {
  const r = world(t)
  preflight(relaunch(r), { commands_file: commandsFile(t, ALL) })
  const got = roleCommands(loadRole('implementer').role, commandsOf(r, E), readTree(r, E).nodes.get('a'))
  const expected = [ALL.build, ALL.typecheck, ALL.lint, ALL.suite, ALL.suite_fast, ALL.test_one.split('{file}')[0].trim()]
  for (const c of expected) assert.ok(got.includes(c), c)
})

test('a later execution\'s measurement reads the session\'s absent commands from their gotchas', async (t) => {
  const r = world(t)
  preflight(relaunch(r), { commands_file: commandsFile(t, { suite: 'node --test --test-reporter=spec', absent: { build: true, typecheck: true, lint: true } }) })
  // The next execution's session names no commands: its envelope holds none, so only the gotchas say them.
  const xc = relaunch(r, OTHER)
  preflight(xc, {})
  assert.equal(xc.envelope().commands, null)
  assert.equal((await acquireAsync(r, { effort: E, execution: OTHER, node: 'a' })).ok, true)
  const folder = ensureIntegration(r, E, '.', xc.envelope())
  assert.equal(folder.ok, true, folder.error)
  const made = ensureLeaf(r, E, 'a', { from: folder.head, parentBranch: folder.branch })
  assert.equal(made.ok, true, made.error)
  xc.log.append('dispatched', { node: 'a', dispatch: dispatchKey({ node: 'a', role: 'implementer', thread: 'producer:a', round: 1 }), round: 1, thread: 'producer:a', role: 'implementer' })
  const head = commitIn(made.worktree, { 'src/a.mjs': 'export const a = () => 1\n' }, 'Add a')
  const out = await mergeBatch(xc, { target: '.', children: [{ id: 'a', head_sha: head }], cycles: [] })
  assert.equal(out.verified, true, JSON.stringify(out.stops || out.error || null))
  const { measurement } = JSON.parse(readFileSync(out.drift_record, 'utf8'))
  assert.deepEqual([measurement.build, measurement.typecheck, measurement.lint], ['absent', 'absent', 'absent'])
})

const VITEST = 'npm --prefix viewer exec -- vitest run --root viewer {file}'
const stateOf = (r, stamp = STAMP) => readFileSync(join(executionDir(r, E, stamp), 'state.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))

test('a test_one map names a test_one per scope, which commandsOf, the brief and the role\'s commands read', (t) => {
  const r = world(t)
  const out = preflight(relaunch(r), { commands_file: commandsFile(t, { test_one: { '.': 'node --test {file}', 'viewer/': VITEST } }) })
  assert.equal(out.ok, true, JSON.stringify(out))
  const found = commandsOf(r, E)
  assert.equal(found.test_one, 'node --test {file}')
  assert.deepEqual(found.test_one_by_path, { viewer: VITEST })
  const { text } = leafBrief(r, E, 'a', { worktree: join(r, 'wt'), commands: found })
  assert.ok(text.includes('test_one for files under viewer/: `' + VITEST + '`'))
  const got = roleCommands(loadRole('implementer').role, found, readTree(r, E).nodes.get('a'))
  assert.ok(got.includes(VITEST.split('{file}')[0].trim()))
})

test('a resumed execution\'s commands file adds a setup per folder, which the brief shows as run and the implementer may run', (t) => {
  const r = world(t)
  preflight(relaunch(r), { commands_file: commandsFile(t, { test_one: 'node --test {file}' }) })
  const steps = 'npm --prefix viewer install && npm --prefix viewer run build'
  const again = preflight(relaunch(r), { commands_file: commandsFile(t, { setup: { viewer: steps } }) })
  assert.equal(again.ok, true, JSON.stringify(again))
  const found = commandsOf(r, E)
  assert.deepEqual([found.setup, found.setup_by_path], ['', { viewer: steps }])
  const { text } = leafBrief(r, E, 'a', { worktree: join(r, 'wt'), commands: found })
  assert.ok(text.includes('setup of viewer/: `' + steps + '`'))
  assert.ok(text.includes('Setup has run in your worktree'))
  const got = roleCommands(loadRole('implementer').role, found, readTree(r, E).nodes.get('a'))
  assert.ok(got.includes(steps))
})

test('a commands file handed to a resumed execution adds the scopes it names, and the tree\'s test_one stands', (t) => {
  const r = world(t)
  preflight(relaunch(r), { commands_file: commandsFile(t, { test_one: 'node --test {file}' }) })
  const again = preflight(relaunch(r), { commands_file: commandsFile(t, { test_one: { viewer: VITEST } }) })
  assert.equal(again.ok, true, JSON.stringify(again))
  const found = commandsOf(r, E)
  assert.equal(found.test_one, 'node --test {file}')
  assert.deepEqual(found.test_one_by_path, { viewer: VITEST })
  assert.equal(envelopeOf(r).commands.test_one, 'node --test {file}', 'the envelope keeps what the new execution was given')
})

test('a resumed execution\'s commands file corrects the commands its replace lists, once, with a command-replaced line', (t) => {
  const r = world(t)
  writeGotcha(r, E, commandGotcha('suite', 'npm test'), { source: { role: 'investigator' } })
  preflight(relaunch(r), { commands_file: commandsFile(t, { suite: 'node --test test/' }) })
  assert.equal(commandsOf(r, E).suite, 'npm test', 'unlisted, the established command stands')
  const fix = commandsFile(t, { suite: 'node --test test/ && npm --prefix viewer test', replace: ['suite'] })
  assert.equal(preflight(relaunch(r), { commands_file: fix }).ok, true)
  assert.equal(commandsOf(r, E).suite, 'node --test test/ && npm --prefix viewer test')
  assert.equal(gotchaOf(r, 'suite').source.role, 'session')
  const replaced = stateOf(r).filter((e) => e.kind === 'command-replaced')
  assert.equal(replaced.length, 1)
  assert.deepEqual([replaced[0].name, replaced[0].path, replaced[0].was.value], ['suite', '', 'npm test'])
  preflight(relaunch(r), { commands_file: fix })
  preflight(relaunch(r), {})
  assert.equal(stateOf(r).filter((e) => e.kind === 'command-replaced').length, 1, 'the same correction again records nothing')
  assert.equal(commandsOf(r, E).suite, 'node --test test/ && npm --prefix viewer test', 'the envelope does not undo the correction')
})

test('a resumed execution\'s commands file that is not JSON is refused commands_unreadable', (t) => {
  const r = world(t)
  preflight(relaunch(r), {})
  const bad = commandsFile(t, {})
  writeFileSync(bad, '{ nope')
  const out = preflight(relaunch(r), { commands_file: bad })
  assert.deepEqual([out.ok, out.error.kind], [false, 'commands_unreadable'])
})
