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
import { acquire } from '../lib/locks.mjs'
import { loadRole, roleCommands } from '../lib/roles.mjs'
import { dispatchKey, executionDir } from '../lib/store.mjs'
import { readTree } from '../lib/tree.mjs'
import { commitIn, git, leaf, repo, root, STAMP } from './harness/boundary-fixture.mjs'
import { seedTree } from './harness/seed-tree.mjs'

const E = 'e1'
const OTHER = '20260925-130000'
const NAMES = ['build', 'typecheck', 'suite', 'suite_fast', 'test_one']
const ALL = {
  build: 'node build.mjs', typecheck: 'node typecheck.mjs', suite: 'node --test',
  suite_fast: 'node --test test/unit', test_one: 'node --test {file}',
}

/** A repository holding a root and leaf `a` as the effort's tree, removed after the test. */
function world(t) {
  const r = repo()
  t.after(() => rmSync(r, { recursive: true, force: true }))
  const seeded = seedTree(r, E, [root(), leaf('a', { locus: ['src/a.mjs'] })])
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
  assert.deepEqual(commandsOf(r, E).absent, { build: false, typecheck: false, suite: false, suite_fast: false })
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
  assert.deepEqual(found.absent, { build: true, typecheck: true, suite: false, suite_fast: true })
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
  const expected = [ALL.build, ALL.typecheck, ALL.suite, ALL.suite_fast, ALL.test_one.split('{file}')[0].trim()]
  for (const c of expected) assert.ok(got.includes(c), c)
})

test('a later execution\'s measurement reads the session\'s absent commands from their gotchas', async (t) => {
  const r = world(t)
  preflight(relaunch(r), { commands_file: commandsFile(t, { suite: 'node --test --test-reporter=spec', absent: { build: true, typecheck: true } }) })
  // The next execution's session names no commands: its envelope holds none, so only the gotchas say them.
  const xc = relaunch(r, OTHER)
  preflight(xc, {})
  assert.equal(xc.envelope().commands, null)
  assert.equal(acquire(r, { effort: E, execution: OTHER, node: 'a', locus: ['src/a.mjs'] }).ok, true)
  const folder = ensureIntegration(r, E, '.', xc.envelope())
  assert.equal(folder.ok, true, folder.error)
  const made = ensureLeaf(r, E, 'a', { from: folder.head, parentBranch: folder.branch })
  assert.equal(made.ok, true, made.error)
  xc.log.append('dispatched', { node: 'a', dispatch: dispatchKey({ node: 'a', role: 'implementer', thread: 'producer:a', round: 1 }), round: 1, thread: 'producer:a', role: 'implementer' })
  const head = commitIn(made.worktree, { 'src/a.mjs': 'export const a = () => 1\n' }, 'Add a')
  const out = await mergeBatch(xc, { target: '.', children: [{ id: 'a', head_sha: head }], cycles: [] })
  assert.equal(out.verified, true, JSON.stringify(out.stops || out.error || null))
  const { measurement } = JSON.parse(readFileSync(out.drift_record, 'utf8'))
  assert.deepEqual([measurement.build, measurement.typecheck], ['absent', 'absent'])
})
