// test/next.test.mjs — compute-next-action over real efforts on disk: specs, ledger lines, events
// and execution directories, never a fake of what lib/next.mjs reads.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { recordApproval, recordReviewed } from '../lib/approval.mjs'
import { compileEffort } from '../lib/compile.mjs'
import { append } from '../lib/ledger.mjs'
import { listFolders, nextAction, nextForAll } from '../lib/next.mjs'
import { executionDir, executionRunId, returnPath, runJsonPath, specPath, writeJson } from '../lib/store.mjs'
import { DEAD_PID } from './harness/dead-pid.mjs'

const NEXT = fileURLToPath(new URL('../lib/next.mjs', import.meta.url))
const STAMP = '20260926-100000'

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'agentics-next-'))
  execFileSync('git', ['init', '-q', dir])
  return dir
}

/** A spec in the grammar lib/spec.mjs parses. `plan` and `questions` are lines. */
function spec({ title = 'The change', decisions = [['D1', 'do it']], plan = [], questions = [], design = 'As the plan says.' } = {}) {
  return [
    '# ' + title, '', '## Intent', '', 'Make ' + title + ' true.', '',
    '## Decisions', '',
    ...(decisions.length ? ['| id | decision | why |', '|---|---|---|', ...decisions.map(([id, text]) => '| ' + id + ' | ' + text + ' | asked for |')] : []),
    '', '## Design', '', design, '',
    '## Plan', '', ...plan, '',
    '## Open questions', '', ...questions, '',
    '## Evidence', '', 'None gathered.', '',
  ].join('\n')
}
const subEffort = (name, realises, author = 'you') =>
  ['- **' + name + '** — sub-effort · realises: ' + realises.join(', ') + ' · author: ' + author, '  Build ' + name + '.']
const skipped = (name, kind) => ['- **' + name + '** — ' + kind + ' · realises: ', '  Skip ' + name + '.']
const task = (name, realises) => [
  '- **' + name + '** — task · realises: ' + realises.join(', ') + ' · rigor: tdd · expects: src/' + name + '.mjs',
  '  Add ' + name + '.',
  '  - [ ] ' + name + ' works — check: `node --test`',
]

function write(r, effort, folder, text) {
  const path = specPath(r, effort, folder)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}
const approve = (r, effort, folder) => assert.equal(recordApproval(r, effort, folder).ok, true)
const event = (r, effort, entry) => assert.equal(append(r, effort, 'events', { execution: STAMP, ...entry }).ok, true)

function openExecution(r, effort, root) {
  const dir = executionDir(r, effort, STAMP)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'execution.json'), JSON.stringify({ stamp: STAMP, root }))
}

/** An approved root with one task, compiled. */
function built(r, effort = 'e1') {
  write(r, effort, '.', spec({ plan: task('x', ['D1']) }))
  approve(r, effort, '.')
  assert.equal(compileEffort(r, effort).ok, true)
}

test('a root with no spec, and a root spec not approved yet, go to design (rule 3)', () => {
  const r = repo()
  mkdirSync(dirname(specPath(r, 'e1', '.')), { recursive: true })
  const bare = nextAction(r, 'e1')
  assert.deepEqual([bare.rule, bare.folder, bare.command], [3, '.', '/agentics:design e1'])

  write(r, 'e1', '.', spec({ plan: task('x', ['D1']) }))
  const drafted = nextAction(r, 'e1')
  assert.deepEqual([drafted.rule, drafted.command], [3, '/agentics:design e1'])
})

test('a blocking question is never approved, and sends even an approved spec\'s edit back to design (rule 3)', () => {
  const r = repo()
  const blocked = spec({ plan: task('x', ['D1']), questions: ['- **blocking:** which store holds the queue?'] })
  write(r, 'e1', '.', blocked)
  assert.equal(recordApproval(r, 'e1', '.').ok, false, 'the Grill\'s gate: no approval over a blocking question')
  const drafted = nextAction(r, 'e1')
  assert.deepEqual([drafted.rule, drafted.command], [3, '/agentics:design e1'])
  assert.ok(drafted.why.includes('which store holds the queue?'))

  write(r, 'e1', '.', spec({ plan: task('x', ['D1']) }))
  approve(r, 'e1', '.')
  write(r, 'e1', '.', blocked)
  const n = nextAction(r, 'e1')
  assert.deepEqual([n.rule, n.command], [3, '/agentics:design e1'], 'rule 3 before rule 4: the edit added a blocking question')
  assert.ok(n.why.includes('which store holds the queue?'))
})

test('a partial review of the spec on disk goes back to the probe for the axes it left (rule 3)', () => {
  const r = repo()
  const text = spec({ plan: task('x', ['D1']) })
  write(r, 'e1', '.', text)
  const left = ['contract-ambiguity', 'growth']
  assert.equal(recordReviewed(r, 'e1', '.', { complete: false, remaining: left }).ok, true)
  const n = nextAction(r, 'e1')
  assert.deepEqual([n.rule, n.folder, n.command], [3, '.', '/agentics:design e1'])
  for (const axis of left) assert.ok(n.why.includes(axis), axis)

  write(r, 'e1', '.', text.replace('As the plan says.', 'As the plan says, edited.'))
  const after = nextAction(r, 'e1')
  assert.equal(after.command, '/agentics:design e1')
  for (const axis of left) assert.ok(!after.why.includes(axis), 'a review of other text is not this text\'s review: ' + axis)

  write(r, 'e1', '.', text)
  assert.equal(recordReviewed(r, 'e1', '.', { complete: true, remaining: [] }).ok, true)
  const whole = nextAction(r, 'e1')
  assert.equal(whole.command, '/agentics:design e1')
  for (const axis of left) assert.ok(!whole.why.includes(axis), 'the latest review was whole: ' + axis)
})

test('an approved spec edited since: review the change (rule 4)', () => {
  const r = repo()
  write(r, 'e1', '.', spec({ plan: task('x', ['D1']) }))
  approve(r, 'e1', '.')
  write(r, 'e1', '.', spec({ plan: task('x', ['D1']), design: 'As the plan says, and one more sentence.' }))
  const n = nextAction(r, 'e1')
  assert.deepEqual([n.rule, n.folder, n.command], [4, '.', '/agentics:design e1'])
})

test('an approved spec whose sub-effort you author has no spec: design that sub-effort (rule 5)', () => {
  const r = repo()
  write(r, 'e1', '.', spec({ plan: subEffort('entities', ['D1']) }))
  approve(r, 'e1', '.')
  const n = nextAction(r, 'e1')
  assert.deepEqual([n.rule, n.folder, n.command], [5, 'entities', '/agentics:design entities'])
})

test('a sub-effort the planner authors is develop\'s, never design\'s', () => {
  const r = repo()
  write(r, 'e1', '.', spec({ plan: subEffort('p', ['D1'], 'planner') }))
  approve(r, 'e1', '.')
  write(r, 'e1', 'p', spec({ title: 'P', decisions: [], plan: task('y', ['D1']) }))
  const n = nextAction(r, 'e1')
  assert.deepEqual([n.rule, n.command], [6, '/agentics:develop e1'])
  const commands = [n.command, ...n.alternatives.map((a) => a.command)]
  assert.ok(!commands.includes('/agentics:design p'), commands.join(', '))
})

test('approved with nothing dispatched: develop it (rule 6)', () => {
  const r = repo()
  write(r, 'e1', '.', spec({ plan: task('x', ['D1']) }))
  approve(r, 'e1', '.')
  const n = nextAction(r, 'e1')
  assert.deepEqual([n.rule, n.folder, n.command], [6, '.', '/agentics:develop e1'])
})

test('a sub-effort dropped after its own spec was approved is never offered by rule 5 or 6', () => {
  const r = repo()
  write(r, 'e1', '.', spec({ decisions: [], plan: subEffort('x', []) }))
  approve(r, 'e1', '.')
  write(r, 'e1', 'x', spec({ title: 'X', decisions: [], plan: task('y', []) }))
  approve(r, 'e1', 'x')
  assert.equal(compileEffort(r, 'e1').ok, true)

  write(r, 'e1', '.', spec({ decisions: [], plan: skipped('x', 'dropped') }))
  approve(r, 'e1', '.')
  const compiled = compileEffort(r, 'e1')
  assert.equal(compiled.ok, true)
  assert.ok(compiled.retired.includes('x'), compiled.retired.join(', '))

  const n = nextAction(r, 'e1')
  const commands = [n.command, ...n.alternatives.map((a) => a.command)]
  assert.ok(!commands.includes('/agentics:design x'), commands.join(', '))
  assert.ok(!commands.includes('/agentics:develop x'), commands.join(', '))
})

test('a sub-effort deferred after its own spec was approved is never offered by rule 5 or 6', () => {
  const r = repo()
  write(r, 'e1', '.', spec({ decisions: [], plan: subEffort('x', []) }))
  approve(r, 'e1', '.')
  write(r, 'e1', 'x', spec({ title: 'X', decisions: [], plan: task('y', []) }))
  approve(r, 'e1', 'x')
  assert.equal(compileEffort(r, 'e1').ok, true)

  write(r, 'e1', '.', spec({ decisions: [], plan: skipped('x', 'deferred') }))
  approve(r, 'e1', '.')
  const compiled = compileEffort(r, 'e1')
  assert.equal(compiled.ok, true)
  assert.ok(compiled.retired.includes('x'), compiled.retired.join(', '))

  const n = nextAction(r, 'e1')
  const commands = [n.command, ...n.alternatives.map((a) => a.command)]
  assert.ok(!commands.includes('/agentics:design x'), commands.join(', '))
  assert.ok(!commands.includes('/agentics:develop x'), commands.join(', '))
})

test('a sub-effort of a dropped sub-effort is never offered by rule 5, even though its own folder is still approved', () => {
  const r = repo()
  write(r, 'e1', '.', spec({ decisions: [], plan: subEffort('a', []) }))
  approve(r, 'e1', '.')
  write(r, 'e1', 'a', spec({ title: 'A', decisions: [], plan: subEffort('b', []) }))
  approve(r, 'e1', 'a')

  const before = nextAction(r, 'e1')
  assert.deepEqual([before.rule, before.folder, before.command], [5, 'a/b', '/agentics:design a/b'], 'b is offered before a is dropped')

  write(r, 'e1', '.', spec({ decisions: [], plan: skipped('a', 'dropped') }))
  approve(r, 'e1', '.')

  const after = nextAction(r, 'e1')
  const commands = [after.command, ...after.alternatives.map((c) => c.command)]
  assert.ok(!commands.includes('/agentics:design a/b'), commands.join(', '))
})

test('a sub-effort whose entry is removed outright, not merely skipped, is an orphan never offered by rule 5 or 6', () => {
  const r = repo()
  write(r, 'e1', '.', spec({ decisions: [], plan: [...subEffort('x', []), ...task('z', [])] }))
  approve(r, 'e1', '.')
  write(r, 'e1', 'x', spec({ title: 'X', decisions: [], plan: task('y', []) }))
  approve(r, 'e1', 'x')
  assert.equal(compileEffort(r, 'e1').ok, true)

  write(r, 'e1', '.', spec({ decisions: [], plan: task('z', []) }))
  approve(r, 'e1', '.')
  const compiled = compileEffort(r, 'e1')
  assert.equal(compiled.ok, true)
  assert.ok(compiled.retired.includes('x'), compiled.retired.join(', '))

  const n = nextAction(r, 'e1')
  const commands = [n.command, ...n.alternatives.map((a) => a.command)]
  assert.ok(!commands.includes('/agentics:design x'), commands.join(', '))
  assert.ok(!commands.includes('/agentics:develop x'), commands.join(', '))
})

test('an open execution wins over everything else (rule 1), and the rest become alternatives', () => {
  const r = repo()
  write(r, 'e1', '.', spec({ plan: task('x', ['D1']) }))
  openExecution(r, 'e1', '.')
  const n = nextAction(r, 'e1')
  assert.deepEqual([n.rule, n.folder, n.command], [1, '.', '/agentics:develop e1'])
  assert.ok(n.why.includes(STAMP))
  assert.equal(n.alternatives[0].command, '/agentics:design e1')
})

test('a parked node names what it waits on and the spec to edit (rule 2)', () => {
  const r = repo()
  built(r)
  event(r, 'e1', { kind: 'parked', node: 'x', return: 'needs_decision', question: 'which format?' })
  const n = nextAction(r, 'e1')
  assert.deepEqual([n.rule, n.folder, n.command], [2, '.', '/agentics:develop e1'])
  for (const fact of ['x', 'needs_decision', 'which format?', 'DESIGN.md']) assert.ok(n.why.includes(fact), fact)
})

test('a sub-effort parked for design is designed (rule 2)', () => {
  const r = repo()
  write(r, 'e1', '.', spec({ plan: subEffort('entities', ['D1']) }))
  approve(r, 'e1', '.')
  assert.equal(compileEffort(r, 'e1').ok, true)
  event(r, 'e1', { kind: 'parked', node: 'entities', return: 'needs_design', question: 'design it' })
  const n = nextAction(r, 'e1')
  assert.deepEqual([n.rule, n.command], [2, '/agentics:design entities'])
})

test('the root integrated: land it (rule 7), never while its review is due; landed: nothing left (rule 0)', () => {
  const r = repo()
  built(r)
  event(r, 'e1', { kind: 'dispatched', node: 'x', role: 'implementer', round: 1, model: 'sonnet', effort: 'medium' })
  event(r, 'e1', { kind: 'merged', node: 'x', into: 'agentics/e1', merged_sha: 'm1', head_sha: 'h1' })
  assert.notEqual(nextAction(r, 'e1').rule, 7, 'a root whose review is due is not landed')
  event(r, 'e1', { kind: 'claims', node: '.', head_sha: 'h1', review: 'done', claims: [] })
  const ready = nextAction(r, 'e1')
  assert.deepEqual([ready.rule, ready.folder, ready.command], [7, '.', '/agentics:develop e1'])

  event(r, 'e1', { kind: 'landed', node: '.', into: 'main', merged_sha: 'm2' })
  const done = nextAction(r, 'e1')
  assert.deepEqual([done.rule, done.command, done.alternatives], [0, '', []])
})

test('ties go depth-first in sorted folder-id order, and the answer never varies', () => {
  const r = repo()
  write(r, 'e1', '.', spec({ plan: [...subEffort('a', ['D1']), ...subEffort('a-x', ['D1'])] }))
  approve(r, 'e1', '.')
  write(r, 'e1', 'a', spec({ title: 'A', decisions: [], plan: subEffort('c', ['D1']) }))
  approve(r, 'e1', 'a')
  write(r, 'e1', 'a/c', spec({ title: 'C', decisions: [], plan: task('y', ['D1']) }))
  write(r, 'e1', 'a-x', spec({ title: 'AX', decisions: [], plan: task('z', ['D1']) }))
  const n = nextAction(r, 'e1')
  assert.deepEqual([n.rule, n.folder, n.command], [3, 'a/c', '/agentics:design a/c'], 'a/c sits under a, which sorts before a-x')
  assert.equal(n.alternatives[0].command, '/agentics:design a-x')
  assert.deepEqual(nextAction(r, 'e1'), n)
})

test('alternatives are at most two, distinct, and never the winner', () => {
  const r = repo()
  write(r, 'e1', '.', spec({ plan: ['b', 'c', 'd', 'e'].flatMap((name) => subEffort(name, ['D1'])) }))
  approve(r, 'e1', '.')
  const n = nextAction(r, 'e1')
  assert.equal(n.command, '/agentics:design b')
  const commands = n.alternatives.map((a) => a.command)
  assert.deepEqual(commands, ['/agentics:design c', '/agentics:design d'])
  assert.equal(new Set([n.command, ...commands]).size, 1 + commands.length)
})

test('listFolders names each folder as a command would', () => {
  const r = repo()
  write(r, 'e1', '.', spec({ plan: subEffort('entities', ['D1']) }))
  approve(r, 'e1', '.')
  write(r, 'e1', 'entities', spec({ title: 'Entities', decisions: [], plan: task('y', ['D1']) }))
  const folders = listFolders(r)
  const root = folders.find((f) => f.effort === 'e1' && f.folder === '.')
  const sub = folders.find((f) => f.effort === 'e1' && f.folder === 'entities')
  assert.deepEqual([root.name, root.title, root.state], ['e1', 'The change', 'approved'])
  assert.deepEqual([sub.name, sub.title, sub.state], ['entities', 'Entities', 'none'])
  assert.ok(folders.indexOf(root) < folders.indexOf(sub))
})

test('nextForAll gives each effort its own Next line', () => {
  const r = repo()
  write(r, 'e1', '.', spec({ plan: task('x', ['D1']), questions: ['- **blocking:** which?'] }))
  write(r, 'e2', '.', spec({ plan: task('x', ['D1']) }))
  approve(r, 'e2', '.')
  const all = nextForAll(r)
  for (const effort of ['e1', 'e2']) {
    const entry = all.find((e) => e.effort === effort)
    assert.ok(entry, effort)
    assert.deepEqual(entry.next, nextAction(r, effort))
  }
})

test('the CLI prints the Next line first, and the same payload with --json', () => {
  const r = repo()
  write(r, 'e1', '.', spec({ plan: task('x', ['D1']) }))
  approve(r, 'e1', '.')
  const expected = nextAction(r, 'e1')
  const text = spawnSync(process.execPath, [NEXT, '--repo', r, '--effort', 'e1'], { encoding: 'utf8' })
  assert.equal(text.status, 0, text.stderr)
  assert.ok(text.stdout.split('\n')[0].startsWith('Next: ' + expected.command), text.stdout)
  const json = spawnSync(process.execPath, [NEXT, '--repo', r, '--effort', 'e1', '--json'], { encoding: 'utf8' })
  assert.deepEqual(JSON.parse(json.stdout).payload, expected)
})

test('a stop quotes the lead of its dispatch\'s stored return (rule 2)', () => {
  const r = repo()
  built(r)
  const dispatch = 'x.implementer.producer-x.r1'
  const lead = 'Keep the cache on disk or in memory?'
  writeJson(returnPath(executionDir(r, 'e1', STAMP), dispatch), { status: 'blocked', text: lead + '\nOn disk survives a restart.' })
  append(r, 'e1', 'state:' + STAMP, { kind: 'closed', status: 'done' })
  event(r, 'e1', { kind: 'parked', node: 'x', return: 'needs_decision', question: '', said: dispatch })
  const n = nextAction(r, 'e1')
  assert.equal(n.rule, 2)
  assert.ok(n.why.includes('(needs_decision): ' + lead + ';'), n.why)
  assert.ok(!n.why.includes('survives a restart'), 'the Next line carries the first line only')

  event(r, 'e1', { kind: 'parked', node: 'x', return: 'needs_decision', question: '', said: 'gone.implementer.r1' })
  assert.ok(nextAction(r, 'e1').why.includes('(needs_decision); the spec to edit is'), 'a return never stored says nothing more')
})

test('an open execution names a live run to watch apart from a stopped one to relaunch (rule 1)', () => {
  const r = repo()
  write(r, 'e1', '.', spec({ plan: task('x', ['D1']) }))
  openExecution(r, 'e1', '.')
  const run = executionRunId('e1', STAMP)
  assert.match(nextAction(r, 'e1').why, /is stopped: relaunch it$/, 'an execution no run has started yet')
  const meta = (pid) => writeJson(runJsonPath(r, run), { run, pid, heartbeat_at: new Date().toISOString() })
  meta(process.pid)
  const live = nextAction(r, 'e1')
  assert.deepEqual([live.rule, live.command], [1, '/agentics:develop e1'])
  assert.ok(live.why.endsWith('is running as run ' + run + ': watch it'), live.why)
  meta(DEAD_PID)
  assert.match(nextAction(r, 'e1').why, /is stopped: relaunch it$/, 'a run whose process is gone')
})

test('the next CLI refuses a value that is not a handle, and a flag it does not take', () => {
  const refusal = (...args) => {
    try {
      execFileSync(process.execPath, [NEXT, ...args], {
        encoding: 'utf8', stdio: 'pipe', env: { ...process.env, NODE_TEST_CONTEXT: '' }, timeout: 30_000,
      })
      return [0, '']
    } catch (err) {
      return [err.status, JSON.parse(err.stdout).kind]
    }
  }
  assert.deepEqual(refusal('--repo', '.', '--effort', 'e\n1'), [1, 'args_unreadable'])
  assert.deepEqual(refusal('folders', '--repo', '."'), [1, 'args_unreadable'])
  assert.deepEqual(refusal('--repo', '.', '--all'), [1, 'unknown_flag'])
  // the verb is not a positional: the walk starts after it
  assert.deepEqual(refusal('folders', '--repo', repo(), '--json'), [0, ''])
})
